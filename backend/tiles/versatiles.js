/**
 * A reader of the VersaTiles containers of version 2, as the specification
 * of VersaTiles:
 * https://github.com/versatiles-org/versatiles-spec/blob/main/v02/readme.md
 *
 * A VersaTiles file has a header of 66 bytes, the metadata, the blocks, and
 * the block index. A block has the tiles of a square of up to 256 × 256
 * tiles of one zoom level, then the tile index of the block. The block index
 * and the tile indexes are always in brotli. The numbers are big-endian. The
 * reader reads only the parts that a request needs, each with one request
 * of a range: the start of the file, the block index, the tile index of a
 * block, and the tile.
 */
import { RangedFile } from "@rfetch/lib/ranged";

import { decompress, TilesError } from "./tileset.js";

/** The bytes of the header. */
const HEADER = 66;
/** The bytes of the first read: the header, and the metadata in most files. */
const FIRST = 16384;
/** The bytes of an entry of the block index. */
const BLOCK_ENTRY = 33;
/** The bytes of an entry of a tile index. */
const TILE_ENTRY = 12;
/** The tiles on a side of a block. */
const BLOCK_SIDE = 256;
/** The highest zoom level, as VersaTiles. */
export const MAX_ZOOM = 30;

/**
 * The content codings of HTTP, by the values of `precompression` in the
 * header.
 */
const CODINGS = new Map([[0, "identity"], [1, "gzip"], [2, "br"], [3, "zstd"]]);

/** The types of the tiles, by the values of `tile_format` in the header. */
const TYPES = new Map([
  [0x00, ""],
  [0x10, "png"],
  [0x11, "jpg"],
  [0x12, "webp"],
  [0x13, "avif"],
  [0x14, "svg"],
  [0x20, "mvt"],
  [0x21, "geojson"],
  [0x22, "topojson"],
  [0x23, "json"],
]);

/** @param {string} message */
const malformed = (message) => new TilesError(`versatiles: ${message}`);

/**
 * The header of a VersaTiles file.
 * @typedef {Object} Header
 * @property {string} type
 * @property {string} encoding
 * @property {number} minZoom
 * @property {number} maxZoom
 * @property {number} metadataOffset
 * @property {number} metadataLength
 * @property {number} indexOffset
 * @property {number} indexLength
 */

/**
 * Reads a big-endian integer of 64 bits that must be a safe integer.
 * @param {DataView} view
 * @param {number} offset
 */
function u64(view, offset) {
  const value = view.getBigUint64(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw malformed("an offset or a length is too large");
  }
  return Number(value);
}

/**
 * Reads the header. As the specification, a value that is reserved stops
 * the read of the file.
 * @param {Uint8Array} bytes The first bytes of the file.
 * @returns {Header}
 */
export function readHeader(bytes) {
  const magic = new TextDecoder().decode(bytes.subarray(0, 14));
  if (!magic.startsWith("versatiles_v")) {
    throw malformed("not a VersaTiles file");
  }
  if (magic !== "versatiles_v02") {
    throw new TilesError(
      `versatiles: the version ${magic.slice(12)} is not supported`,
      501,
    );
  }
  if (bytes.length < HEADER) throw malformed("the header is not complete");
  const type = TYPES.get(bytes[14]);
  if (type === undefined) {
    throw new TilesError(
      `versatiles: the tile format ${bytes[14]} is not supported`,
      501,
    );
  }
  const encoding = CODINGS.get(bytes[15]);
  if (encoding === undefined) {
    throw new TilesError(
      `versatiles: the compression ${bytes[15]} is not supported`,
      501,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER);
  return {
    type,
    encoding,
    minZoom: bytes[16],
    maxZoom: bytes[17],
    metadataOffset: u64(view, 34),
    metadataLength: u64(view, 42),
    indexOffset: u64(view, 50),
    indexLength: u64(view, 58),
  };
}

/**
 * A block: the tiles from `xMin` up to `xMax` and from `yMin` up to `yMax`,
 * in the coordinates of the zoom level, with all the limits.
 * @typedef {Object} Block
 * @property {number} z
 * @property {number} xMin
 * @property {number} yMin
 * @property {number} xMax
 * @property {number} yMax
 * @property {number} offset The place of the block in the file.
 * @property {number} tilesLength The bytes of the tiles of the block.
 * @property {number} indexLength The bytes of the tile index, after the
 *   tiles.
 */

/**
 * The key of a block in the block index.
 * @param {number} z
 * @param {number} column The column of the block: x / 256.
 * @param {number} row The row of the block: y / 256.
 */
const keyOf = (z, column, row) => `${z}/${column}/${row}`;

/**
 * Reads the block index, after decompression.
 * @param {Uint8Array} bytes
 * @returns {Map<string, Block>} The blocks by their keys. For two entries
 *   of one block, the last one wins, as VersaTiles.
 */
export function readBlockIndex(bytes) {
  if (bytes.length % BLOCK_ENTRY !== 0) {
    throw malformed("the length of the block index is not correct");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  /** @type {Map<string, Block>} */
  const blocks = new Map();
  for (let start = 0; start < bytes.length; start += BLOCK_ENTRY) {
    const z = bytes[start];
    const column = view.getUint32(start + 1);
    const row = view.getUint32(start + 5);
    const [xMin, yMin, xMax, yMax] = bytes.subarray(start + 9, start + 13);
    const size = 2 ** z;
    const block = {
      z,
      xMin: column * BLOCK_SIDE + xMin,
      yMin: row * BLOCK_SIDE + yMin,
      xMax: column * BLOCK_SIDE + xMax,
      yMax: row * BLOCK_SIDE + yMax,
      offset: u64(view, start + 13),
      tilesLength: u64(view, start + 21),
      indexLength: view.getUint32(start + 29),
    };
    if (
      z > MAX_ZOOM || xMin > xMax || yMin > yMax || block.xMax >= size ||
      block.yMax >= size
    ) {
      throw malformed("a block of the block index is not correct");
    }
    blocks.set(keyOf(z, column, row), block);
  }
  return blocks;
}

/**
 * A tile: its place in the file.
 * @typedef {{ offset: number, length: number }} Tile
 */

/**
 * A VersaTiles file of a remote, read in parts: a tile set of tileset.js.
 * @implements {import("./tileset.js").TileSet}
 */
export class VersaTiles {
  format = "versatiles";
  /** @type {RangedFile} */
  file;
  /** @type {Header} */
  header;
  /** @type {Uint8Array} */
  first;
  /** @type {Map<string, Block>} */
  blocks;
  /**
   * The most tile indexes that a request reads.
   * @type {number}
   */
  blockBudget;

  /**
   * @param {RangedFile} file
   * @param {Header} header
   * @param {Uint8Array} first The first bytes of the file.
   * @param {Map<string, Block>} blocks
   * @param {number} blockBudget
   */
  constructor(file, header, first, blocks, blockBudget) {
    this.file = file;
    this.header = header;
    this.first = first;
    this.blocks = blocks;
    this.blockBudget = blockBudget;
  }

  get minZoom() {
    return this.header.minZoom;
  }

  get maxZoom() {
    return this.header.maxZoom;
  }

  /** The type of the tiles, or "" for a type that is not known. */
  get type() {
    return this.header.type;
  }

  /** The content coding of the stored tiles. */
  get encoding() {
    return this.header.encoding;
  }

  /**
   * Reads the header and the block index: two requests.
   * @param {RangedFile} file
   * @param {number} [blockBudget] The most tile indexes that a request
   *   reads.
   */
  static async open(file, blockBudget = 32) {
    const first = await file.read(0, FIRST);
    const header = readHeader(first);
    const { indexOffset, indexLength } = header;
    if (indexLength === 0) {
      // A file with no tile.
      return new VersaTiles(file, header, first, new Map(), blockBudget);
    }
    const bytes = indexOffset + indexLength <= first.length
      ? first.subarray(indexOffset, indexOffset + indexLength)
      : await file.read(indexOffset, indexLength);
    if (bytes.length !== indexLength) {
      throw malformed("the block index is out of the file");
    }
    const blocks = readBlockIndex(
      await decompress(bytes, "br", "versatiles", "the block index"),
    );
    return new VersaTiles(file, header, first, blocks, blockBudget);
  }

  /** The metadata, in JSON, after decompression, or null for no metadata. */
  async metadata() {
    const { metadataOffset, metadataLength, encoding } = this.header;
    if (metadataLength === 0) return null;
    const end = metadataOffset + metadataLength;
    const bytes = end <= this.first.length
      ? this.first.subarray(metadataOffset, end)
      : await this.file.read(metadataOffset, metadataLength);
    if (bytes.length !== metadataLength) {
      throw malformed("the metadata are out of the file");
    }
    return await decompress(bytes, encoding, "versatiles", "the metadata");
  }

  /**
   * Reads the tile index of a block, in the budget of the request.
   * @param {Block} block
   * @returns {Promise<DataView>} An entry of 12 bytes for each tile.
   */
  async #tileIndex(block) {
    if (this.blockBudget <= 0) {
      throw new TilesError(
        "versatiles: the request needs too many blocks",
        501,
      );
    }
    this.blockBudget--;
    const { offset, tilesLength, indexLength } = block;
    const bytes = await this.file.read(offset + tilesLength, indexLength);
    if (bytes.length !== indexLength) {
      throw malformed("a tile index is out of the file");
    }
    const index = await decompress(bytes, "br", "versatiles", "a tile index");
    const count = (block.xMax - block.xMin + 1) * (block.yMax - block.yMin + 1);
    if (index.length !== count * TILE_ENTRY) {
      throw malformed("a tile index does not have the tiles of its block");
    }
    return new DataView(index.buffer, index.byteOffset, index.length);
  }

  /**
   * The tile of an entry of a tile index, or null for no tile.
   * @param {Block} block
   * @param {DataView} index
   * @param {number} entry
   * @returns {Tile | null}
   */
  #tileAt(block, index, entry) {
    const offset = u64(index, entry * TILE_ENTRY);
    const length = index.getUint32(entry * TILE_ENTRY + 8);
    if (length === 0) return null;
    if (offset + length > block.tilesLength) {
      throw malformed("a tile is out of its block");
    }
    return { offset: block.offset + offset, length };
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
    const block = this.blocks.get(
      keyOf(z, Math.floor(x / BLOCK_SIDE), Math.floor(y / BLOCK_SIDE)),
    );
    if (
      !block || x < block.xMin || x > block.xMax || y < block.yMin ||
      y > block.yMax
    ) {
      return null;
    }
    const index = await this.#tileIndex(block);
    const width = block.xMax - block.xMin + 1;
    return this.#tileAt(
      block,
      index,
      (y - block.yMin) * width + (x - block.xMin),
    );
  }

  /**
   * The tiles of a zoom level, or of one column of it.
   * @param {number} z
   * @param {number} limit The most tiles: more gives an error 501.
   * @param {number} [x] The column, for only the tiles of the column.
   * @returns {Promise<Array<{ x: number, y: number, length: number }>>}
   */
  async zoom(z, limit, x) {
    /** @type {Array<{ x: number, y: number, length: number }>} */
    const tiles = [];
    for (const block of this.blocks.values()) {
      if (
        block.z !== z ||
        (x !== undefined && (x < block.xMin || x > block.xMax))
      ) {
        continue;
      }
      const index = await this.#tileIndex(block);
      const width = block.xMax - block.xMin + 1;
      const count = index.byteLength / TILE_ENTRY;
      for (let entry = 0; entry < count; entry++) {
        const column = block.xMin + entry % width;
        if (x !== undefined && column !== x) continue;
        const tile = this.#tileAt(block, index, entry);
        if (!tile) continue;
        if (tiles.length >= limit) {
          throw new TilesError(
            `versatiles: the list has more than ${limit} tiles`,
            501,
          );
        }
        tiles.push({
          x: column,
          y: block.yMin + Math.floor(entry / width),
          length: tile.length,
        });
      }
    }
    return tiles;
  }
}
