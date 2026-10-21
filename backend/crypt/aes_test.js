import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { aes256, aes256js } from "./aes.js";

/** @param {string} text */
const hex = (text) => Uint8Array.from(Buffer.from(text, "hex"));

test("AES-256 in JavaScript gives the vector of FIPS-197, appendix C.3", () => {
  const key = hex(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  );
  const plain = hex("00112233445566778899aabbccddeeff");
  const cipher = hex("8ea2b7ca516745bfeafc49904b496089");
  const aes = aes256js(key);
  assert.deepEqual(aes.encrypt(plain), cipher);
  assert.deepEqual(aes.decrypt(cipher), plain);
  // The input does not change.
  assert.deepEqual(plain, hex("00112233445566778899aabbccddeeff"));
});

const KEY = fc.uint8Array({ minLength: 32, maxLength: 32 });
const BLOCKS = fc.integer({ min: 1, max: 8 }).chain((blocks) =>
  fc.uint8Array({ minLength: blocks * 16, maxLength: blocks * 16 })
);

test("AES-256 in JavaScript gives the blocks of node:crypto", () => {
  fc.assert(
    fc.property(KEY, BLOCKS, (key, blocks) => {
      const native = aes256(key);
      const js = aes256js(key);
      const encrypted = native.encrypt(blocks);
      assert.deepEqual(js.encrypt(blocks), new Uint8Array(encrypted));
      assert.deepEqual(js.decrypt(encrypted), blocks);
    }),
  );
});

test("aes256 uses JavaScript when node:crypto has no AES", () => {
  // As createCipheriv of unenv in a build of Cloudflare Pages.
  const stub = {
    createCipheriv() {
      throw new Error("[unenv] crypto.createCipheriv is not implemented yet!");
    },
    createDecipheriv() {
      throw new Error(
        "[unenv] crypto.createDecipheriv is not implemented yet!",
      );
    },
  };
  const key = new Uint8Array(32).fill(7);
  const blocks = new Uint8Array(32).fill(1);
  const fallback = aes256(key, stub);
  const encrypted = fallback.encrypt(blocks);
  assert.deepEqual(encrypted, new Uint8Array(aes256(key).encrypt(blocks)));
  assert.deepEqual(fallback.decrypt(encrypted), blocks);
});

test("AES-256 in JavaScript refuses a key or data of a wrong size", () => {
  assert.throws(() => aes256js(new Uint8Array(16)), RangeError);
  assert.throws(
    () => aes256js(new Uint8Array(32)).encrypt(new Uint8Array(15)),
    RangeError,
  );
});
