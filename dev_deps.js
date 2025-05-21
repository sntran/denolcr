import {
  deepEqual as assertEquals,
  notDeepEqual as assertNotEquals,
  ok as assert,
  rejects as assertRejects,
} from "node:assert/strict";
export { assert, assertEquals, assertNotEquals, assertRejects };

/**
 * Asserts a header
 * @param {Headers} headers
 * @param {string} name
 * @param {string} [value]
 */
export function assertHeader(headers, name, value) {
  if (value !== undefined) {
    assertEquals(
      headers.get(name),
      value,
      `should have ${name} header of ${value} instead of ${headers.get(name)}`,
    );
  } else {
    assert(headers.get(name), `should have ${name} header`);
  }
}

/**
 * Checks if two byte arrays are equal
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function equalBytes(a, b) {
  // Should not happen
  if (a.length !== b.length) return false;
  let isSame = true;
  for (let i = 0; i < a.length; i++) isSame &&= a[i] === b[i]; // Lets hope JIT won't optimize away.
  return isSame;
}

export * as fc from "fast-check";
