/**
 * @module crypt/secretbox
 */
import { xsalsa20poly1305 } from "https://esm.sh/@noble/ciphers@0.3.0/salsa";

// Default magic to be empty.
const EMPTY_MAGIC = new Uint8Array();

export class EncryptionStream extends TransformStream {
  constructor(key = randomBytes(32), options = {}) {
    const { magic = EMPTY_MAGIC } = options;
    // Generates initial nonce from OS's crypto strong random number generator.
    const nonce = randomBytes(24);
    const cipher = xsalsa20poly1305(key, nonce);

    super({
      start(controller) {
        const header = new Uint8Array(magic.length + nonce.length);
        header.set(magic);
        header.set(nonce, magic.length);
        controller.enqueue(header);
      },
      transform(plaintext, controller) {
        const ciphertext = cipher.encrypt(plaintext);
        controller.enqueue(ciphertext);
      },
    });
  }
}

export class DecryptionStream extends TransformStream {
  constructor(key, options = {}) {
    const { magic = EMPTY_MAGIC, blockSize = 64 * 1024 } = options;
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
        if (buffer.byteLength >= blockLength) {
          const block = buffer.slice(0, blockLength); // Extract the block
          buffer = buffer.slice(blockLength); // Remove the processed portion from the buffer

          const cipher = xsalsa20poly1305(key, nonce);
          const plaintext = cipher.decrypt(block);
          controller.enqueue(plaintext);

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
