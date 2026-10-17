import decodeBase32 from "base32-decode";
import encodeBase32 from "base32-encode";
import { aes256 } from "./aes.js";
import * as EME from "./eme.js";

/** The size of a block of AES and of the padding, in bytes. */
const BLOCK_SIZE = 16;
/** The largest encrypted name that rclone decrypts, in bytes. */
const MAX_SIZE = 2048;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * @typedef {Object} PathCipherOptions
 * @property {Uint8Array} [nameKey]
 * @property {Uint8Array} [nameTweak]
 */

/**
 * @typedef {Object} PathCipher
 * @property {function(string): string} encryptName
 * @property {function(string): string} decryptName
 * @property {function(string): string} encrypt
 * @property {function(string): string} decrypt
 */

/**
 * Creates a path cipher, as the standard name encryption of rclone crypt with
 * the base32 encoding: EME with AES-256, PKCS#7 padding, and base32hex in
 * lowercase with no padding.
 * @param {PathCipherOptions} param0
 * @returns {PathCipher}
 */
export default function PathCipher({ nameKey, nameTweak } = {}) {
  if (nameKey === undefined || nameTweak === undefined) {
    throw new Error("nameKey and nameTweak must be specified");
  }
  const nameCipher = aes256(nameKey);

  /**
   * Encrypts a name
   * @param {string} name
   * @returns {string}
   */
  function encryptName(name) {
    if (name === "") return "";
    const padded = pad(encoder.encode(name));
    const ciphertext = EME.encrypt(nameCipher, nameTweak, padded);
    return encodeBase32(ciphertext, "RFC4648-HEX", { padding: false })
      .toLowerCase();
  }

  /**
   * Encrypts a path name
   * @param {string} pathname
   * @returns {string}
   */
  function encrypt(pathname) {
    return pathname
      .split("/")
      .map(encryptName)
      .join("/");
  }

  /**
   * Decrypts a name, with the checks of `decryptSegment` of rclone.
   * @param {string} name
   * @returns {string}
   * @throws {Error} For a name that is not an encrypted name of this key.
   */
  function decryptName(name) {
    // An empty segment of a path stays empty, as in rclone.
    if (name === "") return "";
    const ciphertext = new Uint8Array(
      decodeBase32(name.toUpperCase(), "RFC4648-HEX"),
    );
    if (ciphertext.length % BLOCK_SIZE !== 0) {
      throw new Error("not a multiple of blocksize");
    }
    if (ciphertext.length === 0) {
      throw new Error("too short after base32 decode");
    }
    if (ciphertext.length > MAX_SIZE) {
      throw new Error("too long after base32 decode");
    }
    const padded = EME.decrypt(nameCipher, nameTweak, ciphertext);
    return decoder.decode(unpad(padded));
  }

  /**
   * Decrypts a pathname
   * @param {string} pathname
   * @returns {string}
   */
  function decrypt(pathname) {
    return pathname
      .split("/")
      .map(decryptName)
      .join("/");
  }

  return {
    encryptName,
    decryptName,
    encrypt,
    decrypt,
  };
}

/**
 * Adds PKCS#7 padding: 1 to 16 bytes, each with the number of the bytes.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function pad(bytes) {
  const count = BLOCK_SIZE - bytes.length % BLOCK_SIZE;
  const padded = new Uint8Array(bytes.length + count);
  padded.set(bytes);
  padded.fill(count, bytes.length);
  return padded;
}

/**
 * Removes PKCS#7 padding, with the checks of the package pkcs7 of rclone.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function unpad(bytes) {
  const count = bytes[bytes.length - 1];
  if (count === 0 || count > BLOCK_SIZE) {
    throw new Error("bad padding");
  }
  for (let index = bytes.length - count; index < bytes.length; index++) {
    if (bytes[index] !== count) {
      throw new Error("bad padding");
    }
  }
  return bytes.subarray(0, bytes.length - count);
}
