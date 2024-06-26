import { AES } from "https://esm.sh/aes-js@3.1.2";
import {
  pad,
  Padding,
  unpad,
} from "https://deno.land/x/crypto/src/utils/padding.ts";
import { default as decodeBase32 } from "https://esm.sh/base32-decode@1.0.0";
import { default as encodeBase32 } from "https://esm.sh/base32-encode@2.0.0";
import { Decrypt, Encrypt } from "./eme.js";

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
  // Name Cipher Fuctions
  // TODO: Switch to https://github.com/invisal/god_crypto/blob/master/src/aes/aes_wc.ts
  const nameCipher = new AES(nameKey);

  /**
   * Encrypts a name
   * @param {string} name
   * @returns {string}
   */
  function encryptName(name) {
    if (name === "") return "";
    const ciphertext = encoder.encode(name);
    const paddedCipherText = pad(ciphertext, Padding.PKCS7, 16);
    const rawCipherText = Encrypt(nameCipher, nameTweak, paddedCipherText);

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
    const rawCipherText = new Uint8Array(
      decodeBase32(name.toUpperCase(), "RFC4648-HEX"),
    );
    const paddedPlaintext = Decrypt(nameCipher, nameTweak, rawCipherText);
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
