/**
 * The gzip of the compress backend of rclone: the format of `sgzip`, a
 * gzip that a reader can start in the middle.
 *
 * The data are in blocks of 1 MiB. Each block has its own compressor, with
 * no dictionary, and ends with a sync flush: thus the compressed data of a
 * block start on a byte, and a reader can start at a block. The last block
 * is the end of the deflate stream. All the file is one normal gzip member:
 * `gzip -d` reads it.
 *
 * The metadata of a file tell the size of each block, after the size of the
 * gzip header: `{ BlockSize, Size, BlockData }`.
 */

import * as zlib from "node:zlib";

import { crc32 } from "@rfetch/lib/crc32";

/** The size of a block of the data, before the compression. */
export const BLOCK_SIZE = 1 << 20;

/** The size of the sample of a file that tells if it compresses. */
export const SAMPLE_SIZE = 1 << 20;

/** A file compresses when its sample is this many times smaller, as rclone. */
const MIN_RATIO = 1.1;

/**
 * The metadata of a gzip file, as `sgzip.GzipMetadata`.
 * @typedef {{ BlockSize: number, Size: number, BlockData: number[] | null }} GzipMetadata
 */

/**
 * The options of zlib for a level of compression of Go, from -2 to 9.
 * @param {number} level
 * @returns {import("node:zlib").ZlibOptions}
 */
function zlibOptions(level) {
  // -2 is only Huffman encoding, in Go and in zlib.
  if (level === -2) {
    return { level: -1, strategy: zlib.constants.Z_HUFFMAN_ONLY };
  }
  return { level };
}

/**
 * Tells if a level of compression is correct for gzip.
 * @param {number} level
 * @throws {Error} With the message of sgzip, when it is not.
 */
export function checkLevel(level) {
  if (!Number.isInteger(level) || level < -2 || level > 9) {
    throw new Error(`gzip: invalid compression level: ${level}`);
  }
}

/**
 * The header of a gzip file of sgzip: no name, the time of `time.Time{}` of
 * Go, and the system 255.
 * @param {number} level
 */
function header(level) {
  // The extra flags tell the best compression (2) and the best speed (4).
  const flags = level === 9 ? 2 : level === 1 ? 4 : 0;
  return Uint8Array.of(0x1f, 0x8b, 8, 0, 0x00, 0x09, 0x6e, 0x88, flags, 0xff);
}

/**
 * The number of bits of the bytes in a Huffman code of their counts, with
 * the end of the block one time.
 * @param {Uint8Array} bytes
 */
function huffmanBits(bytes) {
  const counts = new Array(256).fill(0);
  for (const byte of bytes) counts[byte]++;
  const weights = [...counts.filter((count) => count > 0), 1].sort((a, b) =>
    a - b
  );
  // With two symbols, each code has 1 bit.
  if (weights.length <= 2) return bytes.length + 1;
  // Each join of the two smallest weights adds one bit to their symbols.
  let bits = 0;
  while (weights.length > 1) {
    const weight = weights.shift() + weights.shift();
    bits += weight;
    const index = weights.findIndex((other) => other > weight);
    weights.splice(index === -1 ? weights.length : index, 0, weight);
  }
  return bits;
}

/**
 * Tells if a file compresses, from its first bytes, as `isCompressible` of
 * rclone: the compressed sample must be 1.1 times smaller.
 *
 * rclone uses the deflate of Go (klauspost/compress, level 5), and rfetch
 * uses zlib. For a sample of less than 128 bytes, the rules of Go are
 * here: Go keeps 32 bytes or less as they are, and uses only a Huffman code
 * for less than 128 bytes, with a header of 70 bytes in its estimate. For a
 * larger sample, zlib decides. Then the two can decide differently for data
 * with few repeats, for example random digits or base64. Both layouts are
 * correct, and rclone and rfetch read both.
 * @param {Uint8Array} sample At most `SAMPLE_SIZE` bytes.
 */
export function isCompressible(sample) {
  const { length } = sample;
  if (length <= 32) return false;
  /** @type {import("node:zlib").ZlibOptions} */
  const options = { level: -1, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  if (length < 128) {
    let estimate = huffmanBits(sample) + 70 * 8;
    estimate += estimate >> 7;
    // A stored block has a header of 5 bytes.
    if ((length + 5) * 8 <= estimate) return false;
    options.strategy = zlib.constants.Z_HUFFMAN_ONLY;
  }
  const deflated = zlib.deflateRawSync(sample, options);
  // The header, the block, the last empty block and the trailer.
  const size = 10 + deflated.length + 2 + 8;
  return length / size > MIN_RATIO;
}

/**
 * A stream that compresses a file in the format of sgzip. After the end of
 * the stream, `metadata` tells the blocks.
 * @extends {TransformStream<Uint8Array, Uint8Array>}
 */
export class GzipStream extends TransformStream {
  /** @type {GzipMetadata} */
  metadata = { BlockSize: BLOCK_SIZE, Size: 0, BlockData: [] };

  /** @param {number} level From -2 to 9, as Go. */
  constructor(level) {
    checkLevel(level);
    const options = zlibOptions(level);
    const buffer = new Uint8Array(BLOCK_SIZE);
    let used = 0;
    let crc = 0;
    const start = header(level);
    /** @type {number[]} */
    const blocks = [start.length];
    let size = 0;

    /**
     * Compresses the block in the buffer.
     * @param {TransformStreamDefaultController<Uint8Array>} controller
     * @param {boolean} last
     */
    const compress = (controller, last) => {
      const block = zlib.deflateRawSync(
        buffer.subarray(0, used),
        last
          ? options
          : { ...options, finishFlush: zlib.constants.Z_SYNC_FLUSH },
      );
      blocks.push(block.length);
      controller.enqueue(
        new Uint8Array(block.buffer, block.byteOffset, block.length),
      );
      used = 0;
    };

    super({
      start(controller) {
        controller.enqueue(start);
      },
      transform(chunk, controller) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        let offset = 0;
        while (offset < chunk.length) {
          const length = Math.min(BLOCK_SIZE - used, chunk.length - offset);
          buffer.set(chunk.subarray(offset, offset + length), used);
          used += length;
          offset += length;
          if (used === BLOCK_SIZE) compress(controller, false);
        }
      },
      flush: (controller) => {
        compress(controller, true);
        const trailer = new Uint8Array(8);
        const view = new DataView(trailer.buffer);
        view.setUint32(0, crc, true);
        view.setUint32(4, size % 2 ** 32, true);
        controller.enqueue(trailer);
        this.metadata = {
          BlockSize: BLOCK_SIZE,
          Size: size,
          BlockData: blocks,
        };
      },
    });
  }
}

/**
 * Where to read the compressed data for a range of the file: the start of
 * the block of the first byte, and the end of the last block, before the
 * trailer of gzip.
 * @param {GzipMetadata} metadata
 * @param {number} start The first byte of the range in the file.
 * @returns {{ from: number, to: number, skip: number } | null} The first
 *   and the last byte of the compressed data, and the bytes to skip after
 *   the decompression. Null when the metadata do not tell the blocks.
 */
export function blocksFor({ BlockSize, BlockData }, start) {
  if (!BlockData || BlockData.length < 2 || !(BlockSize > 0)) return null;
  const block = Math.floor(start / BlockSize);
  // The compressed data of a block start after the header and the blocks
  // before it.
  let from = 0;
  let to = 0;
  for (const [index, size] of BlockData.entries()) {
    if (index <= block) from += size;
    to += size;
  }
  return { from, to: to - 1, skip: start - block * BlockSize };
}
