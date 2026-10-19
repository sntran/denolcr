/**
 * A writer of PMTiles files of version 3 for the tests, as the
 * specification: a header, the root directory, the metadata, the leaf
 * directories and the data of the tiles. go-pmtiles verify accepts its
 * files: see main_test.js.
 */
import { brotliCompressSync, gzipSync } from "node:zlib";

import { tileId } from "./pmtiles.js";

const encoder = new TextEncoder();

/** The numbers of the compressions in the header. */
export const COMPRESSIONS = { none: 1, gzip: 2, brotli: 3, zstd: 4 };

/**
 * @param {Uint8Array} bytes
 * @param {number} compression
 */
function compress(bytes, compression) {
  if (compression === COMPRESSIONS.gzip) return new Uint8Array(gzipSync(bytes));
  if (compression === COMPRESSIONS.brotli) {
    return new Uint8Array(brotliCompressSync(bytes));
  }
  // Another compression: the tests only need data that rfetch does not
  // read.
  return bytes;
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

  const parts = [header, rootBytes, metadataBytes, ...leaves, ...data];
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
