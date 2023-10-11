/**
 * @module crypt/secretbox
 */
import { xsalsa20poly1305 } from "https://esm.sh/@noble/ciphers@0.3.0/salsa";

// Default magic to be empty.
const EMPTY_MAGIC = new Uint8Array();

/**
 * Generates random bytes using the operating systems crypto strong random
 * @param {number} length The number of the random bytes to generate
 * @returns {Uint8Array}
 */
function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

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
    const { magic = EMPTY_MAGIC } = options;
    let cipher = null;

    super({
      transform(ciphertext, controller) {
        if (!cipher) {
          // Extracts nonce from header, after the magic.
          const nonce = ciphertext.slice(magic.length, magic.length + 24);
          cipher = xsalsa20poly1305(key, nonce);
          ciphertext = ciphertext.slice(magic.length + 24);
        }

        if (ciphertext.byteLength === 0) {
          return;
        }

        const plaintext = cipher.decrypt(ciphertext);
        controller.enqueue(plaintext);
      },
    });
  }
}
