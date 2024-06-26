import { assertEquals, fc } from "../../dev_deps.js";
import { obscure, reveal } from "./main.js";

/**
 * Asserts a text Response contains the expected string.
 * @param {Response|Promise<Response>} response
 * @param {string} expected
 */
async function assertResponse(response, expected) {
  response = await response;
  assertEquals(await response.text(), expected);
}

Deno.test("reveal", () => {
  assertResponse(reveal("UmyLSdRHfew6aual28-ggx78qHqSfQ"), "123456");
  assertResponse(reveal("Cj3gLa5PVwc2aot0QpKiOZ3YEzs3Sw"), "654321");
});

Deno.test("obscure", async () => {
  // Tests property that revealing an obscured string should return the original string
  await fc.assert(
    fc.asyncProperty(fc.string(), async (plaintext) => {
      const ciphertext = await obscure(plaintext).then((r) => r.text());
      assertResponse(reveal(ciphertext), plaintext);
    }),
  );
});
