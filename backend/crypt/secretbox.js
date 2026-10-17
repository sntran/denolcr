/**
 * @module crypt/secretbox
 *
 * The format of the data of rclone crypt: a header of the magic bytes and a
 * nonce of 24 bytes, then blocks of NaCl SecretBox (XSalsa20 and Poly1305).
 * Each block has 16 bytes of Poly1305 tag and up to `blockSize` bytes of
 * data. The nonce goes up by 1 for each block, as a number in little-endian
 * bytes.
 */
import { xsalsa20poly1305 } from "@noble/ciphers/salsa";

/**
 * Options for secretbox
 * @typedef {Object} Options
 * @property {Uint8Array} [magic] Magic bytes to prepend to the encrypted data
 * @property {number} [blockSize=65536] Block size in bytes
 */

const DEFAULT_MAGIC = new Uint8Array();
const DEFAULT_BLOCK_SIZE = 64 * 1024;
const NONCE_SIZE = 24;
const TAG_SIZE = 16;

/** The errors of rclone for encrypted data. */
export const Errors = {
  TOO_SHORT: "file is too short to be encrypted",
  BAD_HEADER: "file has truncated block header",
  BAD_MAGIC: "not an encrypted file - bad magic string",
  BAD_BLOCK: "failed to authenticate decrypted block - bad password?",
};

export class EncryptionStream extends TransformStream {
  /**
   * Creates a new encryption stream
   * @param {Uint8Array} key
   * @param {Options} [options]
   */
  constructor(key = randomBytes(32), options = {}) {
    const { magic = DEFAULT_MAGIC, blockSize = DEFAULT_BLOCK_SIZE } = options;
    // Generates initial nonce from OS's crypto strong random number generator.
    const nonce = randomBytes(NONCE_SIZE);
    /** The data that is not a full block yet. */
    let pending = new Uint8Array(0);

    super({
      start(controller) {
        controller.enqueue(concat(magic, nonce));
      },
      transform(chunk, controller) {
        const data = pending.length ? concat(pending, chunk) : chunk;
        let offset = 0;
        for (; data.length - offset >= blockSize; offset += blockSize) {
          const block = data.subarray(offset, offset + blockSize);
          controller.enqueue(xsalsa20poly1305(key, nonce).encrypt(block));
          increment(nonce);
        }
        pending = data.slice(offset);
      },
      flush(controller) {
        if (pending.length > 0) {
          controller.enqueue(xsalsa20poly1305(key, nonce).encrypt(pending));
        }
      },
    });
  }
}

export class DecryptionStream extends TransformStream {
  /**
   * Creates a new decryption stream. It reads the header and the blocks from
   * chunks of any size. An error of the stream has a message of `Errors`.
   * @param {Uint8Array} key
   * @param {Options} [options]
   */
  constructor(key, options = {}) {
    const { magic = DEFAULT_MAGIC, blockSize = DEFAULT_BLOCK_SIZE } = options;
    const headerSize = magic.length + NONCE_SIZE;
    const blockLength = blockSize + TAG_SIZE;

    /** @type {Uint8Array | null} */
    let nonce = null;
    /** The data that is not a full header or block yet. */
    let pending = new Uint8Array(0);

    /** @param {Uint8Array} block */
    function open(block) {
      try {
        return xsalsa20poly1305(key, nonce).decrypt(block);
      } catch {
        throw new Error(Errors.BAD_BLOCK);
      }
    }

    super({
      transform(chunk, controller) {
        const data = pending.length ? concat(pending, chunk) : chunk;
        let offset = 0;
        if (!nonce) {
          if (data.length < headerSize) {
            pending = data.slice();
            return;
          }
          if (magic.some((byte, index) => data[index] !== byte)) {
            throw new Error(Errors.BAD_MAGIC);
          }
          nonce = data.slice(magic.length, headerSize);
          offset = headerSize;
        }
        for (; data.length - offset >= blockLength; offset += blockLength) {
          controller.enqueue(open(data.subarray(offset, offset + blockLength)));
          // The nonce goes up by 1 for each block.
          increment(nonce);
        }
        pending = data.slice(offset);
      },
      flush(controller) {
        if (!nonce) {
          throw new Error(Errors.TOO_SHORT);
        }
        if (pending.length > 0) {
          if (pending.length <= TAG_SIZE) {
            throw new Error(Errors.BAD_HEADER);
          }
          controller.enqueue(open(pending));
        }
      },
    });
  }
}

/**
 * The size of the encrypted data for data of a size.
 * @param {number} size
 * @param {Options} [options]
 * @returns {number}
 */
export function encryptedSize(size, options = {}) {
  const { magic = DEFAULT_MAGIC, blockSize = DEFAULT_BLOCK_SIZE } = options;
  const blocks = Math.floor(size / blockSize);
  const residue = size % blockSize;
  return magic.length + NONCE_SIZE + blocks * (blockSize + TAG_SIZE) +
    (residue ? residue + TAG_SIZE : 0);
}

/**
 * The size of the data in encrypted data of a size, as `DecryptedSize` of
 * rclone.
 * @param {number} size
 * @param {Options} [options]
 * @returns {number}
 * @throws {RangeError} When no encrypted data has the size.
 */
export function decryptedSize(size, options = {}) {
  const { magic = DEFAULT_MAGIC, blockSize = DEFAULT_BLOCK_SIZE } = options;
  const blockLength = blockSize + TAG_SIZE;
  size -= magic.length + NONCE_SIZE;
  if (size < 0) {
    throw new RangeError(Errors.TOO_SHORT);
  }
  const blocks = Math.floor(size / blockLength);
  let residue = size % blockLength;
  if (residue !== 0) {
    residue -= TAG_SIZE;
    if (residue <= 0) {
      throw new RangeError(Errors.BAD_HEADER);
    }
  }
  return blocks * blockSize + residue;
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
 * Adds 1 to the nonce, in place: the first byte is the lowest.
 * @param {Uint8Array} nonce
 */
function increment(nonce) {
  for (let offset = 0; offset < nonce.length; offset++) {
    nonce[offset] = (nonce[offset] + 1) & 0xff;
    // No carry when the byte is not 0 after the addition.
    if (nonce[offset] !== 0) {
      break;
    }
  }
  return nonce;
}
