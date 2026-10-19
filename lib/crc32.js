/**
 * The CRC-32 of gzip and zip (IEEE 802.3).
 */
import * as zlib from "node:zlib";

/** The table of the CRC-32. */
const TABLE = new Int32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc;
});

/**
 * The CRC-32 of bytes, with the CRC of the bytes before.
 * @param {Uint8Array} bytes
 * @param {number} [crc]
 * @returns {number}
 */
export function crc32(bytes, crc = 0) {
  // Node.js 22.2 and later have it in zlib.
  if (typeof zlib.crc32 === "function") return zlib.crc32(bytes, crc);
  let value = ~crc;
  for (let index = 0; index < bytes.length; index++) {
    value = TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return ~value >>> 0;
}
