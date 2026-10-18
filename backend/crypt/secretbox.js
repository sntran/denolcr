/**
 * @module crypt/secretbox
 *
 * The format of the data of rclone crypt: a header of the magic bytes and a
 * nonce of 24 bytes, then blocks of NaCl SecretBox (XSalsa20 and Poly1305).
 * Each block has 16 bytes of Poly1305 tag and up to `blockSize` bytes of
 * data. The nonce goes up by 1 for each block, as a number in little-endian
 * bytes.
 */
import module from "#wasm";

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
        const size = data.length - data.length % blockSize;
        if (size > 0) {
          controller.enqueue(
            seal(key, nonce, data.subarray(0, size), blockSize),
          );
        }
        pending = data.slice(size);
      },
      flush(controller) {
        if (pending.length > 0) {
          controller.enqueue(seal(key, nonce, pending, blockSize));
        }
      },
    });
  }
}

export class DecryptionStream extends TransformStream {
  /**
   * Creates a new decryption stream. It reads the header and the blocks from
   * chunks of any size. An error of the stream has a message of `Errors`.
   *
   * With the option `nonce`, the stream reads blocks with no header, from the
   * block `block` of the file: the nonce of the header goes up by `block`, as
   * `newDecrypterSeek` of rclone. Thus a range of a file needs only its
   * header and its blocks in the range.
   * @param {Uint8Array} key
   * @param {Options & { nonce?: Uint8Array, block?: number }} [options]
   */
  constructor(key, options = {}) {
    const { magic = DEFAULT_MAGIC, blockSize = DEFAULT_BLOCK_SIZE } = options;
    const headerSize = magic.length + NONCE_SIZE;
    const blockLength = blockSize + TAG_SIZE;

    /** @type {Uint8Array | null} */
    let nonce = options.nonce
      ? add(options.nonce.slice(), options.block ?? 0)
      : null;
    /** The data that is not a full header or block yet. */
    let pending = new Uint8Array(0);

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
        const size = data.length - offset -
          (data.length - offset) % blockLength;
        if (size > 0) {
          const boxes = data.subarray(offset, offset + size);
          controller.enqueue(open(key, nonce, boxes, blockSize));
        }
        pending = data.slice(offset + size);
      },
      flush(controller) {
        if (!nonce) {
          throw new Error(Errors.TOO_SHORT);
        }
        if (pending.length > 0) {
          if (pending.length <= TAG_SIZE) {
            throw new Error(Errors.BAD_HEADER);
          }
          controller.enqueue(open(key, nonce, pending, blockSize));
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
 * The functions and the memory of `secretbox.wasm`. The instance comes at
 * the first use.
 * @type {any}
 */
let wasm;

/**
 * Gives a view of the memory of `secretbox.wasm`, with the key and the nonce
 * in it.
 * @param {Uint8Array} key 32 bytes.
 * @param {Uint8Array} nonce 24 bytes.
 */
function load(key, nonce) {
  if (key.length !== 32) throw new RangeError("The key must be 32 bytes.");
  if (nonce.length !== NONCE_SIZE) {
    throw new RangeError(`The nonce must be ${NONCE_SIZE} bytes.`);
  }
  wasm ??= new WebAssembly.Instance(module, {}).exports;
  const memory = new Uint8Array(wasm.memory.buffer);
  memory.set(key, wasm.key());
  memory.set(nonce, wasm.nonce());
  return memory;
}

/**
 * Reads the nonce back from the memory of `secretbox.wasm`, and removes the
 * key from it.
 * @param {Uint8Array} memory
 * @param {Uint8Array} nonce
 */
function unload(memory, nonce) {
  nonce.set(memory.subarray(wasm.nonce(), wasm.nonce() + NONCE_SIZE));
  memory.fill(0, wasm.key(), wasm.key() + 32);
}

/**
 * Seals the data in boxes: a box for each part of `blockSize` bytes, with a
 * tag and the encrypted part. The nonce goes up by 1 for each box, in place.
 * @param {Uint8Array} key
 * @param {Uint8Array} nonce
 * @param {Uint8Array} data
 * @param {number} blockSize
 * @returns {Uint8Array} The boxes.
 */
function seal(key, nonce, data, blockSize) {
  const blocks = Math.ceil(data.length / blockSize);
  const result = new Uint8Array(data.length + blocks * TAG_SIZE);
  let at = 0;
  for (let offset = 0; offset < data.length;) {
    const memory = load(key, nonce);
    // The whole blocks that go in the input of the module.
    const step = Math.floor(wasm.size() / (blockSize + TAG_SIZE)) * blockSize;
    if (step === 0) throw new RangeError("The block size is too large.");
    const part = data.subarray(offset, offset + step);
    memory.set(part, wasm.input());
    const size = wasm.seal(part.length, blockSize);
    result.set(memory.subarray(wasm.output(), wasm.output() + size), at);
    unload(memory, nonce);
    at += size;
    offset += part.length;
  }
  return result;
}

/**
 * Opens the boxes: each box has a tag and `blockSize` bytes of encrypted
 * data, and the last box can be shorter. The nonce goes up by 1 for each
 * box, in place.
 * @param {Uint8Array} key
 * @param {Uint8Array} nonce
 * @param {Uint8Array} boxes
 * @param {number} blockSize
 * @returns {Uint8Array} The data.
 * @throws {Error} With the message `Errors.BAD_BLOCK` for a box that does
 *   not authenticate.
 */
function open(key, nonce, boxes, blockSize) {
  const boxLength = blockSize + TAG_SIZE;
  const count = Math.ceil(boxes.length / boxLength);
  const result = new Uint8Array(boxes.length - count * TAG_SIZE);
  let at = 0;
  for (let offset = 0; offset < boxes.length;) {
    const memory = load(key, nonce);
    // The whole boxes that go in the input of the module.
    const step = Math.floor(wasm.size() / boxLength) * boxLength;
    if (step === 0) throw new RangeError("The block size is too large.");
    const part = boxes.subarray(offset, offset + step);
    memory.set(part, wasm.input());
    const size = wasm.open(part.length, blockSize);
    if (size < 0) {
      unload(memory, nonce);
      throw new Error(Errors.BAD_BLOCK);
    }
    result.set(memory.subarray(wasm.output(), wasm.output() + size), at);
    unload(memory, nonce);
    at += size;
    offset += part.length;
  }
  return result;
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
 * Adds a number to the nonce, in place, as `nonce.add` of rclone: the first
 * byte is the lowest.
 * @param {Uint8Array} nonce
 * @param {number} number
 */
export function add(nonce, number) {
  let carry = BigInt(number);
  for (let offset = 0; offset < nonce.length && carry > 0n; offset++) {
    const sum = BigInt(nonce[offset]) + (carry & 0xffn);
    nonce[offset] = Number(sum & 0xffn);
    carry = (carry >> 8n) + (sum >> 8n);
  }
  return nonce;
}

/**
 * Adds 1 to the nonce, in place: the first byte is the lowest.
 * @param {Uint8Array} nonce
 */
export function increment(nonce) {
  for (let offset = 0; offset < nonce.length; offset++) {
    nonce[offset] = (nonce[offset] + 1) & 0xff;
    // No carry when the byte is not 0 after the addition.
    if (nonce[offset] !== 0) {
      break;
    }
  }
  return nonce;
}
