/**
 * A small reader and writer of DER, for the private keys of PEM files:
 * PKCS #1, SEC 1 and PKCS #8.
 */

import { ProtocolError } from "./wire.js";

/**
 * An element of DER.
 * @typedef {Object} Element
 * @property {number} tag
 * @property {Uint8Array} value
 */

/**
 * Reads the elements of DER in a value, as the children of a SEQUENCE.
 * @param {Uint8Array} bytes
 * @returns {Element[]}
 * @throws {ProtocolError} When the DER is not correct.
 */
export function readDER(bytes) {
  /** @type {Element[]} */
  const elements = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) throw new ProtocolError("DER is too short");
    const tag = bytes[offset++];
    let length = bytes[offset++];
    if (length & 0x80) {
      const count = length & 0x7f;
      if (count === 0 || count > 4 || offset + count > bytes.length) {
        throw new ProtocolError("A DER length is not correct");
      }
      length = 0;
      for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++];
    }
    if (offset + length > bytes.length) {
      throw new ProtocolError("DER is too short");
    }
    elements.push({ tag, value: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  return elements;
}

/**
 * Reads the one element of DER of a value, with the tag that it must have.
 * @param {Uint8Array} bytes
 * @param {number} tag
 */
export function readOne(bytes, tag) {
  const elements = readDER(bytes);
  if (elements.length !== 1 || elements[0].tag !== tag) {
    throw new ProtocolError("DER is not the expected type");
  }
  return elements[0].value;
}

/** The tags of DER. */
export const TAG = {
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
};

/**
 * Writes an element of DER.
 * @param {number} tag
 * @param {...Uint8Array} parts The value, in parts.
 */
export function writeDER(tag, ...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  /** @type {number[]} */
  const header = [tag];
  if (length < 0x80) header.push(length);
  else {
    /** @type {number[]} */
    const digits = [];
    for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
      digits.unshift(rest % 256);
    }
    header.push(0x80 | digits.length, ...digits);
  }
  const bytes = new Uint8Array(header.length + length);
  bytes.set(header);
  let offset = header.length;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/**
 * Writes an OID of DER from its text, for example `1.3.101.112`.
 * @param {string} text
 */
export function oid(text) {
  const numbers = text.split(".").map(Number);
  /** @type {number[]} */
  const bytes = [numbers[0] * 40 + numbers[1]];
  for (const number of numbers.slice(2)) {
    /** @type {number[]} */
    const digits = [number & 0x7f];
    for (let rest = number >>> 7; rest > 0; rest >>>= 7) {
      digits.unshift(0x80 | (rest & 0x7f));
    }
    bytes.push(...digits);
  }
  return writeDER(TAG.OID, Uint8Array.from(bytes));
}

/**
 * Tells if a value of DER is an OID.
 * @param {Uint8Array} value The value of the element, with no tag.
 * @param {string} text
 */
export function isOID(value, text) {
  const expected = oid(text).subarray(2);
  return value.length === expected.length &&
    value.every((byte, i) => byte === expected[i]);
}
