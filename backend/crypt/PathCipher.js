import decodeBase32 from "base32-decode";
import encodeBase32 from "base32-encode";
import { aes256 } from "./aes.js";
import * as EME from "./eme.js";
import { pad, Padding, unpad } from "./padding.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
 * Creates a path cipher.
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
    const ciphertext = encoder.encode(name);
    const paddedCipherText = pad(ciphertext, Padding.PKCS7, 16);
    const rawCipherText = EME.encrypt(nameCipher, nameTweak, paddedCipherText);

    const encodedCipher = encodeBase32(rawCipherText, "RFC4648-HEX");
    return encodedCipher.replace(/=+$/, "").toLowerCase();
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
   * Decrypts a name
   * @param {string} name
   * @returns {string}
   */
  function decryptName(name) {
    // An empty segment of a path stays empty, as in rclone.
    if (name === "") return "";
    const rawCipherText = new Uint8Array(
      decodeBase32(name.toUpperCase(), "RFC4648-HEX"),
    );
    const paddedPlaintext = EME.decrypt(nameCipher, nameTweak, rawCipherText);
    return decoder.decode(unpad(paddedPlaintext, Padding.PKCS7, 16));
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
