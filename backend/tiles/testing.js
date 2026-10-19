/**
 * The writers of the files of tiles for the tests:
 *
 * - PMTiles files of version 3, as the specification: a header, the root
 *   directory, the metadata, the leaf directories and the data of the
 *   tiles. go-pmtiles verify accepts its files: see go_pmtiles_test.js.
 * - VersaTiles files of version 2, as the specification: a header, the
 *   metadata, the blocks, and the block index. The tool versatiles reads
 *   its files: see versatiles_test.js.
 */
import * as zlib from "node:zlib";

import { tileId } from "./pmtiles.js";

const encoder = new TextEncoder();

/** The numbers of the compressions in the header of PMTiles. */
export const COMPRESSIONS = { none: 1, gzip: 2, brotli: 3, zstd: 4 };

/** The numbers of the compressions in the header of VersaTiles. */
export const VERSATILES_COMPRESSIONS = { none: 0, gzip: 1, brotli: 2, zstd: 3 };

/**
 * The tiles of all the zoom levels from 0 up to `max`.
 * @param {number} max
 * @param {(z: number, x: number, y: number) => string} [data]
 */
export function allTiles(max, data = (z, x, y) => `tile ${z}/${x}/${y}`) {
  const tiles = [];
  for (let z = 0; z <= max; z++) {
    for (let x = 0; x < 2 ** z; x++) {
      for (let y = 0; y < 2 ** z; y++) {
        tiles.push({ z, x, y, data: data(z, x, y) });
      }
    }
  }
  return tiles;
}

/** Node.js has zstd in node:zlib from 22.15. */
export const hasZstd = typeof zlib.zstdCompressSync === "function";

/**
 * Compresses bytes.
 * @param {Uint8Array} bytes
 * @param {string} name "none", "gzip", "brotli" or "zstd". Another name
 *   gives the bytes: the tests only need data that rfetch does not read.
 */
function compressAs(bytes, name) {
  if (name === "gzip") return new Uint8Array(zlib.gzipSync(bytes));
  if (name === "brotli") return new Uint8Array(zlib.brotliCompressSync(bytes));
  if (name === "zstd" && hasZstd) {
    return new Uint8Array(zlib.zstdCompressSync(bytes));
  }
  return bytes;
}

/**
 * The name of a compression from its number.
 * @param {Record<string, number>} numbers
 * @param {number} compression
 */
const nameOf = (numbers, compression) =>
  Object.keys(numbers).find((name) => numbers[name] === compression) ?? "";

/**
 * @param {Uint8Array} bytes
 * @param {number} compression A compression of PMTiles.
 */
function compress(bytes, compression) {
  return compressAs(bytes, nameOf(COMPRESSIONS, compression));
}

/**
 * Joins parts of a file.
 * @param {Uint8Array[]} parts
 */
function concat(parts) {
  const file = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    file.set(part, offset);
    offset += part.length;
  }
  return file;
}

/**
 * @param {number[]} out
 * @param {number} value
 */
function varint(out, value) {
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80);
    value = Math.floor(value / 0x80);
  }
  out.push(value);
}

/**
 * An entry of a directory.
 * @typedef {{ id: number, run: number, offset: number, length: number }} Entry
 */

/**
 * The bytes of a directory, before compression.
 * @param {Entry[]} entries
 */
function directoryBytes(entries) {
  /** @type {number[]} */
  const out = [];
  varint(out, entries.length);
  let last = 0;
  for (const { id } of entries) {
    varint(out, id - last);
    last = id;
  }
  for (const { run } of entries) varint(out, run);
  for (const { length } of entries) varint(out, length);
  entries.forEach(({ offset }, index) => {
    const previous = entries[index - 1];
    varint(
      out,
      previous && offset === previous.offset + previous.length ? 0 : offset + 1,
    );
  });
  return new Uint8Array(out);
}

/**
 * Writes a PMTiles file.
 * @param {Array<{ z: number, x: number, y: number, data: Uint8Array | string }>} tiles
 * @param {{
 *   tileType?: number,
 *   tileCompression?: number,
 *   internalCompression?: number,
 *   metadata?: Record<string, unknown>,
 *   leafSize?: number,
 *   levels?: number,
 *   version?: number,
 * }} [options] `tileCompression` compresses the data of each tile.
 *   `leafSize` puts the entries in leaf directories of that size, in
 *   `levels` levels of leaf directories (1 by default).
 */
export function pmtilesFile(tiles, options = {}) {
  const {
    tileType = 1,
    tileCompression = COMPRESSIONS.gzip,
    internalCompression = COMPRESSIONS.gzip,
    metadata = { name: "test" },
    leafSize,
    levels = 1,
    version = 3,
  } = options;
  const sorted = tiles.map((tile) => ({
    ...tile,
    id: tileId(tile.z, tile.x, tile.y),
    bytes: compress(
      typeof tile.data === "string" ? encoder.encode(tile.data) : tile.data,
      tileCompression,
    ),
  })).sort((a, b) => a.id - b.id);

  // The data of the tiles, once for each content, and runs of tiles with
  // the same content.
  /** @type {Map<string, { offset: number, length: number }>} */
  const contents = new Map();
  /** @type {Uint8Array[]} */
  const data = [];
  let dataLength = 0;
  /** @type {Entry[]} */
  const entries = [];
  for (const tile of sorted) {
    const key = Buffer.from(tile.bytes).toString("base64");
    let content = contents.get(key);
    if (!content) {
      content = { offset: dataLength, length: tile.bytes.length };
      contents.set(key, content);
      data.push(tile.bytes);
      dataLength += tile.bytes.length;
    }
    const last = entries.at(-1);
    if (
      last && last.offset === content.offset &&
      last.id + last.run === tile.id
    ) {
      last.run++;
    } else {
      entries.push({ id: tile.id, run: 1, ...content });
    }
  }

  // The leaf directories, from the lowest level up.
  /** @type {Uint8Array[]} */
  const leaves = [];
  let leafLength = 0;
  let root = entries;
  if (leafSize) {
    for (let level = 0; level < levels; level++) {
      /** @type {Entry[]} */
      const pointers = [];
      for (let index = 0; index < root.length; index += leafSize) {
        const chunk = root.slice(index, index + leafSize);
        const bytes = compress(directoryBytes(chunk), internalCompression);
        pointers.push({
          id: chunk[0].id,
          run: 0,
          offset: leafLength,
          length: bytes.length,
        });
        leaves.push(bytes);
        leafLength += bytes.length;
      }
      root = pointers;
    }
  }
  const rootBytes = compress(directoryBytes(root), internalCompression);
  const metadataBytes = compress(
    encoder.encode(JSON.stringify(metadata)),
    internalCompression,
  );
  if (127 + rootBytes.length > 16384) {
    throw new Error("the root directory is too large: use leafSize");
  }

  const header = new Uint8Array(127);
  const view = new DataView(header.buffer);
  header.set(encoder.encode("PMTiles"));
  header[7] = version;
  const rootOffset = 127;
  const metadataOffset = rootOffset + rootBytes.length;
  const leafOffset = metadataOffset + metadataBytes.length;
  const dataOffset = leafOffset + leafLength;
  const fields = [
    rootOffset,
    rootBytes.length,
    metadataOffset,
    metadataBytes.length,
    leafOffset,
    leafLength,
    dataOffset,
    dataLength,
    sorted.length,
    entries.length,
    contents.size,
  ];
  fields.forEach((value, index) => {
    view.setBigUint64(8 + index * 8, BigInt(value), true);
  });
  header[96] = 1; // The data are in the order of the tile IDs.
  header[97] = internalCompression;
  header[98] = tileCompression;
  header[99] = tileType;
  const minZoom = sorted.reduce((min, { z }) => Math.min(min, z), 99);
  const maxZoom = sorted.reduce((max, { z }) => Math.max(max, z), 0);
  header[100] = minZoom;
  header[101] = maxZoom;
  view.setInt32(102, -1800000000, true);
  view.setInt32(106, -850000000, true);
  view.setInt32(110, 1800000000, true);
  view.setInt32(114, 850000000, true);
  header[118] = minZoom;

  return concat([header, rootBytes, metadataBytes, ...leaves, ...data]);
}

/**
 * Writes a VersaTiles file. Each block has the tiles of a square of
 * 256 × 256 tiles, in the smallest rectangle around them. The tiles with
 * the same data in a block have one copy of the data.
 * @param {Array<{ z: number, x: number, y: number, data: Uint8Array | string }>} tiles
 * @param {{
 *   tileFormat?: number,
 *   compression?: number,
 *   metadata?: Record<string, unknown> | null,
 *   minZoom?: number,
 *   maxZoom?: number,
 * }} [options] `compression` compresses the data of each tile and the
 *   metadata. With `metadata: null`, the file has no metadata.
 */
export function versatilesFile(tiles, options = {}) {
  const {
    tileFormat = 0x20,
    compression = VERSATILES_COMPRESSIONS.brotli,
    metadata = { name: "test" },
    minZoom = tiles.reduce((min, { z }) => Math.min(min, z), 99),
    maxZoom = tiles.reduce((max, { z }) => Math.max(max, z), 0),
  } = options;
  const name = nameOf(VERSATILES_COMPRESSIONS, compression);
  const metadataBytes = metadata === null
    ? new Uint8Array(0)
    : compressAs(encoder.encode(JSON.stringify(metadata)), name);

  /** @type {Map<string, Array<{ z: number, x: number, y: number, data: Uint8Array | string }>>} */
  const groups = new Map();
  for (const tile of tiles) {
    const key = `${tile.z}/${tile.x >> 8}/${tile.y >> 8}`;
    const group = groups.get(key);
    if (group) group.push(tile);
    else groups.set(key, [tile]);
  }

  /** @type {Uint8Array[]} */
  const blocks = [];
  /** @type {Uint8Array[]} */
  const entries = [];
  let offset = 66 + metadataBytes.length;
  for (const group of groups.values()) {
    const { z } = group[0];
    const column = group[0].x >> 8;
    const row = group[0].y >> 8;
    const xs = group.map(({ x }) => x % 256);
    const ys = group.map(({ y }) => y % 256);
    const [xMin, xMax] = [Math.min(...xs), Math.max(...xs)];
    const [yMin, yMax] = [Math.min(...ys), Math.max(...ys)];
    const width = xMax - xMin + 1;
    const index = new Uint8Array(width * (yMax - yMin + 1) * 12);
    const indexView = new DataView(index.buffer);
    /** @type {Map<string, { offset: number, length: number }>} */
    const contents = new Map();
    /** @type {Uint8Array[]} */
    const data = [];
    let length = 0;
    for (const tile of group) {
      const bytes = compressAs(
        typeof tile.data === "string" ? encoder.encode(tile.data) : tile.data,
        name,
      );
      const key = Buffer.from(bytes).toString("base64");
      let content = contents.get(key);
      if (!content) {
        content = { offset: length, length: bytes.length };
        contents.set(key, content);
        data.push(bytes);
        length += bytes.length;
      }
      const entry = (tile.y % 256 - yMin) * width + (tile.x % 256 - xMin);
      indexView.setBigUint64(entry * 12, BigInt(content.offset));
      indexView.setUint32(entry * 12 + 8, content.length);
    }
    const indexBytes = compressAs(index, "brotli");
    blocks.push(...data, indexBytes);

    const entry = new Uint8Array(33);
    const view = new DataView(entry.buffer);
    entry[0] = z;
    view.setUint32(1, column);
    view.setUint32(5, row);
    entry.set([xMin, yMin, xMax, yMax], 9);
    view.setBigUint64(13, BigInt(offset));
    view.setBigUint64(21, BigInt(length));
    view.setUint32(29, indexBytes.length);
    entries.push(entry);
    offset += length + indexBytes.length;
  }
  const blockIndex = compressAs(concat(entries), "brotli");

  const header = new Uint8Array(66);
  const view = new DataView(header.buffer);
  header.set(encoder.encode("versatiles_v02"));
  header[14] = tileFormat;
  header[15] = compression;
  header[16] = minZoom;
  header[17] = maxZoom;
  view.setInt32(18, -1800000000);
  view.setInt32(22, -850511287);
  view.setInt32(26, 1800000000);
  view.setInt32(30, 850511287);
  view.setBigUint64(34, BigInt(metadataBytes.length ? 66 : 0));
  view.setBigUint64(42, BigInt(metadataBytes.length));
  view.setBigUint64(50, BigInt(offset));
  view.setBigUint64(58, BigInt(blockIndex.length));
  return concat([header, metadataBytes, ...blocks, blockIndex]);
}
