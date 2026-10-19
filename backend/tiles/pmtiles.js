/**
 * A reader of the PMTiles files of version 3, as the specification of
 * Protomaps: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 *
 * A PMTiles file has a header of 127 bytes, the root directory, the
 * metadata in JSON, the leaf directories, and the data of the tiles. The
 * header and the root directory are in the first 16 KiB. A directory has
 * entries in the order of the tile IDs: an entry tells a run of tiles with
 * the same data, or a leaf directory. The reader reads only the parts that
 * a request needs, each with one request of a range.
 */
import { RangedFile } from "@rfetch/lib/ranged";

import { decompress, TilesError } from "./tileset.js";

/** The bytes of the header. */
const HEADER = 127;
/** The bytes that have the header and the root directory. */
const FIRST = 16384;
/** The most entries in a directory. */
const MAX_ENTRIES = 1_000_000;
/** The most levels of leaf directories, as the specification. */
const MAX_DEPTH = 3;
/** The highest zoom level: a tile ID of a higher level is not a safe integer. */
export const MAX_ZOOM = 26;

/**
 * The content codings of HTTP, by the numbers of the compressions in the
 * header. A number that is not known stays a number.
 */
const CODINGS = new Map([[1, "identity"], [2, "gzip"], [3, "br"], [4, "zstd"]]);

/** The types of the tiles, by the numbers of the header. */
const TYPES = new Map([
  [1, "mvt"],
  [2, "png"],
  [3, "jpg"],
  [4, "webp"],
  [5, "avif"],
  [6, "mlt"],
]);

/** @param {number} compression A compression of the header. */
const codingOf = (compression) => CODINGS.get(compression) ?? `${compression}`;

/** @param {string} message */
const malformed = (message) => new TilesError(`pmtiles: ${message}`);

/**
 * The header of a PMTiles file.
 * @typedef {Object} Header
 * @property {number} rootOffset
 * @property {number} rootLength
 * @property {number} metadataOffset
 * @property {number} metadataLength
 * @property {number} leafOffset
 * @property {number} leafLength
 * @property {number} dataOffset
 * @property {number} dataLength
 * @property {number} internalCompression
 * @property {number} tileCompression
 * @property {number} tileType
 * @property {number} minZoom
 * @property {number} maxZoom
 */

/**
 * Reads a little-endian integer of 64 bits that must be a safe integer.
 * @param {DataView} view
 * @param {number} offset
 */
function u64(view, offset) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw malformed("an offset or a length is too large");
  }
  return Number(value);
}

/**
 * Reads the header.
 * @param {Uint8Array} bytes The first bytes of the file.
 * @returns {Header}
 */
export function readHeader(bytes) {
  if (
    bytes.length < 8 ||
    new TextDecoder().decode(bytes.subarray(0, 7)) !== "PMTiles"
  ) {
    throw malformed("not a PMTiles file");
  }
  if (bytes[7] !== 3) {
    throw new TilesError(
      `pmtiles: the version ${bytes[7]} is not supported`,
      501,
    );
  }
  if (bytes.length < HEADER) throw malformed("the header is not complete");
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER);
  return {
    rootOffset: u64(view, 8),
    rootLength: u64(view, 16),
    metadataOffset: u64(view, 24),
    metadataLength: u64(view, 32),
    leafOffset: u64(view, 40),
    leafLength: u64(view, 48),
    dataOffset: u64(view, 56),
    dataLength: u64(view, 64),
    internalCompression: bytes[97],
    tileCompression: bytes[98],
    tileType: bytes[99],
    minZoom: bytes[100],
    maxZoom: bytes[101],
  };
}

/**
 * The entries of a directory, in the order of their tile IDs. An entry with
 * a run length of 0 is a leaf directory, at its offset from the start of
 * the leaf directories.
 * @typedef {Object} Directory
 * @property {number[]} ids The first tile ID of each entry.
 * @property {number[]} runs The number of tiles of each entry.
 * @property {number[]} offsets
 * @property {number[]} lengths
 */

/**
 * Reads a directory, after decompression.
 * @param {Uint8Array} bytes
 * @returns {Directory}
 */
export function readDirectory(bytes) {
  let position = 0;
  const varint = () => {
    let value = 0;
    let factor = 1;
    while (true) {
      if (position >= bytes.length) throw malformed("a directory is too short");
      const byte = bytes[position++];
      value += (byte & 0x7f) * factor;
      if (byte < 0x80) break;
      factor *= 128;
      if (factor > 2 ** 56) {
        throw malformed("a number of a directory is too long");
      }
    }
    if (!Number.isSafeInteger(value)) {
      throw malformed("a number of a directory is too large");
    }
    return value;
  };
  const count = varint();
  if (count > MAX_ENTRIES) {
    throw new TilesError(
      `pmtiles: a directory has more than ${MAX_ENTRIES} entries`,
      501,
    );
  }
  // Each entry has 4 numbers, of 1 byte or more.
  if (count * 4 > bytes.length - position) {
    throw malformed("a directory is too short");
  }
  const ids = new Array(count);
  const runs = new Array(count);
  const lengths = new Array(count);
  const offsets = new Array(count);
  let id = 0;
  for (let index = 0; index < count; index++) {
    id += varint();
    if (!Number.isSafeInteger(id)) throw malformed("a tile ID is too large");
    if (index > 0 && id <= ids[index - 1]) {
      throw malformed("the tile IDs of a directory are not in order");
    }
    ids[index] = id;
  }
  for (let index = 0; index < count; index++) runs[index] = varint();
  for (let index = 0; index < count; index++) {
    lengths[index] = varint();
    if (lengths[index] === 0) throw malformed("an entry has no length");
  }
  for (let index = 0; index < count; index++) {
    const value = varint();
    offsets[index] = index > 0 && value === 0
      ? offsets[index - 1] + lengths[index - 1]
      : value - 1;
    if (offsets[index] < 0) throw malformed("an entry has no offset");
  }
  return { ids, runs, offsets, lengths };
}

/**
 * The index of the last entry with a tile ID that is not more than `id`,
 * or -1.
 * @param {Directory} directory
 * @param {number} id
 */
function lastAtOrBefore(directory, id) {
  const { ids } = directory;
  let low = 0;
  let high = ids.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (ids[middle] <= id) low = middle + 1;
    else high = middle - 1;
  }
  return high;
}

/** The number of tiles of the zoom levels before `z`: (4^z - 1) / 3. */
export function firstId(/** @type {number} */ z) {
  return (4 ** z - 1) / 3;
}

/**
 * Turns the position of a tile on the Hilbert curve of the specification.
 * @param {number} size
 * @param {number[]} xy
 * @param {number} rx
 * @param {number} ry
 */
function rotate(size, xy, rx, ry) {
  if (ry === 0) {
    if (rx === 1) {
      xy[0] = size - 1 - xy[0];
      xy[1] = size - 1 - xy[1];
    }
    [xy[0], xy[1]] = [xy[1], xy[0]];
  }
}

/**
 * The tile ID of a tile: the tiles of the zoom levels before, then the
 * place of the tile on the Hilbert curve of its level.
 * @param {number} z At most MAX_ZOOM.
 * @param {number} x
 * @param {number} y
 */
export function tileId(z, x, y) {
  const xy = [x, y];
  let d = 0;
  for (let s = 2 ** z / 2; s >= 1; s /= 2) {
    // Here x and y are less than 2 s.
    const rx = xy[0] >= s ? 1 : 0;
    const ry = xy[1] >= s ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    // The next levels use only the bits under s.
    xy[0] -= rx * s;
    xy[1] -= ry * s;
    rotate(s, xy, rx, ry);
  }
  return firstId(z) + d;
}

/**
 * The tile of a tile ID.
 * @param {number} id
 * @returns {[number, number, number]} z, x and y.
 */
export function tileOf(id) {
  let z = 0;
  while (z < MAX_ZOOM && firstId(z + 1) <= id) z++;
  let t = id - firstId(z);
  const xy = [0, 0];
  for (let s = 1; s < 2 ** z; s *= 2) {
    const rx = Math.floor(t / 2) % 2;
    const ry = (t % 2) ^ rx;
    rotate(s, xy, rx, ry);
    xy[0] += s * rx;
    xy[1] += s * ry;
    t = Math.floor(t / 4);
  }
  return [z, xy[0], xy[1]];
}

/**
 * A tile: its place in the data of the tiles.
 * @typedef {{ offset: number, length: number }} Tile
 */

/**
 * A PMTiles file of a remote, read in parts: a tile set of tileset.js.
 * @implements {import("./tileset.js").TileSet}
 */
export class PMTiles {
  format = "pmtiles";
  /** @type {RangedFile} */
  file;
  /** @type {Header} */
  header;
  /** @type {Directory} */
  root;
  /**
   * The most leaf directories that a request reads.
   * @type {number}
   */
  leafBudget;

  /**
   * @param {RangedFile} file
   * @param {Header} header
   * @param {Directory} root
   * @param {number} leafBudget
   */
  constructor(file, header, root, leafBudget) {
    this.file = file;
    this.header = header;
    this.root = root;
    this.leafBudget = leafBudget;
  }

  get minZoom() {
    return this.header.minZoom;
  }

  get maxZoom() {
    return this.header.maxZoom;
  }

  /** The type of the tiles, or "" for a type that is not known. */
  get type() {
    return TYPES.get(this.header.tileType) ?? "";
  }

  /** The content coding of the stored tiles. */
  get encoding() {
    return codingOf(this.header.tileCompression);
  }

  /**
   * Reads the header and the root directory, with one request in most
   * files.
   * @param {RangedFile} file
   * @param {number} [leafBudget] The most leaf directories that a request
   *   reads.
   */
  static async open(file, leafBudget = 32) {
    const first = await file.read(0, FIRST);
    const header = readHeader(first);
    const { rootOffset, rootLength } = header;
    const bytes = rootOffset + rootLength <= first.length
      ? first.subarray(rootOffset, rootOffset + rootLength)
      : await file.read(rootOffset, rootLength);
    if (bytes.length !== rootLength) {
      throw malformed("the root directory is out of the file");
    }
    const root = readDirectory(
      await decompress(
        bytes,
        codingOf(header.internalCompression),
        "pmtiles",
        "the root directory",
      ),
    );
    return new PMTiles(file, header, root, leafBudget);
  }

  /** The metadata, in JSON, after decompression. */
  async metadata() {
    const { metadataOffset, metadataLength, internalCompression } = this.header;
    const bytes = await this.file.read(metadataOffset, metadataLength);
    if (bytes.length !== metadataLength) {
      throw malformed("the metadata are out of the file");
    }
    return await decompress(
      bytes,
      codingOf(internalCompression),
      "pmtiles",
      "the metadata",
    );
  }

  /**
   * Reads a leaf directory, in the budget of the request.
   * @param {number} offset
   * @param {number} length
   */
  async #leaf(offset, length) {
    if (this.leafBudget <= 0) {
      throw new TilesError(
        "pmtiles: the request needs too many leaf directories",
        501,
      );
    }
    this.leafBudget--;
    const { leafOffset, leafLength, internalCompression } = this.header;
    if (offset + length > leafLength) {
      throw malformed("a leaf directory is out of its part of the file");
    }
    const bytes = await this.file.read(leafOffset + offset, length);
    if (bytes.length !== length) {
      throw malformed("a leaf directory is out of the file");
    }
    return readDirectory(
      await decompress(
        bytes,
        codingOf(internalCompression),
        "pmtiles",
        "a leaf directory",
      ),
    );
  }

  /**
   * The place of a tile in the data of the tiles, or null for a tile that
   * the file does not have.
   * @param {number} id
   * @returns {Promise<Tile | null>}
   */
  async find(id) {
    let directory = this.root;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const index = lastAtOrBefore(directory, id);
      if (index === -1) return null;
      const run = directory.runs[index];
      const offset = directory.offsets[index];
      const length = directory.lengths[index];
      if (run > 0) {
        return id - directory.ids[index] < run ? { offset, length } : null;
      }
      if (depth === MAX_DEPTH) break;
      directory = await this.#leaf(offset, length);
    }
    throw malformed("the leaf directories are too deep");
  }

  /**
   * The tiles with a tile ID from `low` up to `high`, not `high`, in the
   * order of their IDs.
   * @param {number} low
   * @param {number} high
   * @param {number} limit The most tiles: more gives an error 501.
   * @returns {Promise<Array<Tile & { id: number }>>}
   */
  async range(low, high, limit) {
    /** @type {Array<Tile & { id: number }>} */
    const tiles = [];
    /**
     * @param {Directory} directory
     * @param {number} end The first tile ID after the directory.
     * @param {number} depth
     */
    const walk = async (directory, end, depth) => {
      const { ids, runs, offsets, lengths } = directory;
      const start = Math.max(lastAtOrBefore(directory, low), 0);
      for (let index = start; index < ids.length; index++) {
        const first = ids[index];
        if (first >= high) break;
        const next = index + 1 < ids.length ? ids[index + 1] : end;
        if (runs[index] === 0) {
          if (next <= low) continue;
          if (depth === MAX_DEPTH) {
            throw malformed("the leaf directories are too deep");
          }
          await walk(
            await this.#leaf(offsets[index], lengths[index]),
            next,
            depth + 1,
          );
          continue;
        }
        const from = Math.max(first, low);
        const to = Math.min(first + runs[index], high);
        for (let id = from; id < to; id++) {
          if (tiles.length >= limit) {
            throw new TilesError(
              `pmtiles: the list has more than ${limit} tiles`,
              501,
            );
          }
          tiles.push({ id, offset: offsets[index], length: lengths[index] });
        }
      }
    };
    await walk(this.root, Infinity, 0);
    return tiles;
  }

  /**
   * The place of a tile in the file, or null for a tile that the file does
   * not have.
   * @param {number} z
   * @param {number} x
   * @param {number} y
   * @returns {Promise<Tile | null>}
   */
  async tile(z, x, y) {
    if (z > MAX_ZOOM || z < this.minZoom || z > this.maxZoom) return null;
    const tile = await this.find(tileId(z, x, y));
    if (!tile) return null;
    const { dataOffset, dataLength } = this.header;
    if (tile.offset + tile.length > dataLength) {
      throw malformed("a tile is out of the data of the tiles");
    }
    return { offset: dataOffset + tile.offset, length: tile.length };
  }

  /**
   * The tiles of a zoom level.
   * @param {number} z
   * @param {number} limit The most tiles: more gives an error 501.
   * @returns {Promise<Array<{ x: number, y: number, length: number }>>}
   */
  async zoom(z, limit) {
    if (z > MAX_ZOOM) return [];
    const tiles = await this.range(firstId(z), firstId(z + 1), limit);
    return tiles.map(({ id, length }) => {
      const [, x, y] = tileOf(id);
      return { x, y, length };
    });
  }
}
