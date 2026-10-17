import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { obscure, reveal } from "./obscure.js";

/**
 * Asserts a text Response contains the expected string.
 * @param {Response|Promise<Response>} response
 * @param {string} expected
 */
async function assertResponse(response, expected) {
  response = await response;
  assert.deepEqual(await response.text(), expected);
}

test("reveal", () => {
  assertResponse(reveal("UmyLSdRHfew6aual28-ggx78qHqSfQ"), "123456");
  assertResponse(reveal("Cj3gLa5PVwc2aot0QpKiOZ3YEzs3Sw"), "654321");
});

test("obscure", async () => {
  // Tests property that revealing an obscured string should return the original string
  await fc.assert(
    fc.asyncProperty(fc.string(), async (plaintext) => {
      const ciphertext = await obscure(plaintext).then((r) => r.text());
      assertResponse(reveal(ciphertext), plaintext);
    }),
  );
});
