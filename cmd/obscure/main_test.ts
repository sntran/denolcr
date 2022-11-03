import { assertEquals, fc } from "../../dev_deps.ts";
import { obscure, reveal } from "./main.ts";

async function assertResponse(
  response: Response | Promise<Response>,
  expected: string,
) {
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
    fc.asyncProperty(fc.string(), async (plaintext: string) => {
      const ciphertext = await obscure(plaintext).then((r) => r.text());
      assertResponse(reveal(ciphertext), plaintext);
    }),
  );
});
