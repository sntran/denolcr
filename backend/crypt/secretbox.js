/**
 * @module crypt/secretbox
 */
import { xsalsa20poly1305 } from "../../deps.js";

/**
 * Options for secretbox
 * @typedef {Object} Options
 * @property {Uint8Array} [magic] Magic bytes to prepend to the encrypted data
 * @property {number} [blockSize=65536] Block size in bytes
 */

const DEFAULT_MAGIC = new Uint8Array();
const DEFAULT_BLOCK_SIZE = 64 * 1024;

export class EncryptionStream extends TransformStream {
  /**
   * Creates a new encryption stream
   * @param {Uint8Array} key
   * @param {Options} [options]
   */
  constructor(key = randomBytes(32), options = {}) {
    const { magic = DEFAULT_MAGIC, blockSize = DEFAULT_BLOCK_SIZE } = options;
    // Generates initial nonce from OS's crypto strong random number generator.
    let nonce = randomBytes(24);
    let buffer = new Uint8Array();

    super({
      start(controller) {
        const header = new Uint8Array(magic.length + nonce.length);
        header.set(magic);
        header.set(nonce, magic.length);
        controller.enqueue(header);
      },
      transform(chunk, controller) {
        // Concatenate the new chunk with the buffer
        buffer = concat(buffer, chunk);

        while (buffer.byteLength >= blockSize) {
          const block = buffer.slice(0, blockSize); // Extract the block
          const cipher = xsalsa20poly1305(key, nonce);
          const ciphertext = cipher.encrypt(block);
          controller.enqueue(ciphertext);

          buffer = buffer.slice(blockSize); // Remove the processed portion from the buffer
          nonce = increment(nonce);
        }
      },
      flush(controller) {
        // Encrypts the remaining data in the buffer
        if (buffer.byteLength > 0) {
          const cipher = xsalsa20poly1305(key, nonce);
          const ciphertext = cipher.encrypt(buffer);
          controller.enqueue(ciphertext);
        }
      },
    });
  }
}

export class DecryptionStream extends TransformStream {
  /**
   * Creates a new decryption stream
   * @param {Uint8Array} key
   * @param {Options} [options]
   */
  constructor(key, options = {}) {
    const { magic = DEFAULT_MAGIC, blockSize = DEFAULT_BLOCK_SIZE } = options;
    const tagLength = 16;
    const blockLength = blockSize + tagLength;

    let nonce = null;
    let buffer = new Uint8Array();

    super({
      transform(ciphertext, controller) {
        if (!nonce) {
          // Extracts 24-byte nonce from header, after the magic.
          nonce = ciphertext.slice(magic.length, magic.length + 24);
          ciphertext = ciphertext.slice(magic.length + 24);
        }

        if (ciphertext.byteLength === 0) {
          return;
        }

        // Concatenate the new chunk with the buffer
        buffer = concat(buffer, ciphertext);

        // Check if the buffer has enough data for a block
        while (buffer.byteLength >= blockLength) {
          const block = buffer.slice(0, blockLength); // Extract the block
          const cipher = xsalsa20poly1305(key, nonce);
          const plaintext = cipher.decrypt(block);
          controller.enqueue(plaintext);

          buffer = buffer.slice(blockLength); // Remove the processed portion from the buffer
          // The nonce is incremented for each chunk read making sure each nonce is unique for each block written
          nonce = increment(nonce);
        }
      },
      flush(controller) {
        // Decrypts the remaining data in the buffer
        if (buffer.byteLength > 0) {
          const cipher = xsalsa20poly1305(key, nonce);
          const plaintext = cipher.decrypt(buffer);
          controller.enqueue(plaintext);
        }
      },
    });
  }

  /**
   * Calculates original size from encrypted size
   * @param {number} size Encrypted size
   * @param {Options} [options]
   * @returns {number} Original size
   */
  static size(size, options = {}) {
    const { magic = DEFAULT_MAGIC, blockSize = DEFAULT_BLOCK_SIZE } = options;
    const tagLength = 16;
    const blockLength = blockSize + tagLength;

    size = size - magic.length - 24;
    const blocks = Math.floor(size / blockLength);
    const decryptedSize = blocks * blockSize;
    let residue = size % blockLength;
    if (residue !== 0) {
      residue -= tagLength;
    }

    return decryptedSize + residue;
  }
}

/**
 * Generates random bytes using the operating systems crypto strong random
 * @param {number} length The number of the random bytes to generate
 * @returns {Uint8Array}
 */
function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Concats two Uint8Arrays
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {Uint8Array}
 */
function concat(a, b) {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}

/**
 * Increments the nonce by 1
 * @param {Uint8Array} nonce
 * @param {number} offset
 */
function increment(nonce, offset = 0) {
  const length = nonce.byteLength;
  for (; offset < length; offset++) {
    const digit = nonce[offset];
    const newDigit = (digit + 1) % 256;
    nonce[offset] = newDigit;
    if (newDigit >= digit) {
      break;
    }
  }

  return nonce;
}
