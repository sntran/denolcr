import { createCipheriv, createDecipheriv } from "node:crypto";

/**
 * AES-256 of `node:crypto` in ECB mode with no padding, the block cipher of
 * EME. Each call takes one or more blocks of 16 bytes. One object does all
 * the calls of one direction, because ECB keeps no state between blocks.
 * @param {Uint8Array} key 32 bytes.
 * @returns {import("./eme.js").BlockCipher}
 */
export function aes256(key) {
  // ECB has no IV. workerd refuses null, so the IV is empty.
  const iv = new Uint8Array(0);
  const encryptor = createCipheriv("aes-256-ecb", key, iv);
  const decryptor = createDecipheriv("aes-256-ecb", key, iv);
  encryptor.setAutoPadding(false);
  decryptor.setAutoPadding(false);
  return {
    encrypt: (block) => encryptor.update(block),
    decrypt: (block) => decryptor.update(block),
  };
}
