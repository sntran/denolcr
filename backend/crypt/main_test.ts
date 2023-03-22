import { assertEquals, fc } from "../../dev_deps.ts";

import { decode, encode } from "./main.ts";

const PASSWORD = "UmyLSdRHfew6aual28-ggx78qHqSfQ";
const SALT = "Cj3gLa5PVwc2aot0QpKiOZ3YEzs3Sw";

async function getText(response: Response | Promise<Response>) {
  response = await response;
  const text = await response.text();
  return text.replace(/\n$/, "");
}

Deno.test("decode", async () => {
  const options = {
    password: PASSWORD,
    password2: SALT,
  };
  const decoded = await getText(encode(options, "rclone.png"));
  assertEquals(decoded, "mtnq34s46g5ntbnut5ftn4r2dc");
});

Deno.test("encode", async () => {
  const options = {
    password: PASSWORD,
    password2: SALT,
  };

  const plaintexts: string[] = [];

  // Tests property that decoding an encoded string should return the original string.
  // Instead of calling `encode/decode` for individual property values, which consumes
  // lots of time due to getting the key, we collect the generated plaintexts and then
  // encode them all at once.
  fc.assert(
    fc.property(fc.string(), (plaintext: string) => {
      plaintexts.push(plaintext);
    }),
  );

  // Encodes all plaintexts into ciphertexts separated by newlines.
  const ciphertexts = await getText(encode(options, ...plaintexts));
  // Decodes all ciphertexts into plaintexts separated by newlines.
  const decoded = await getText(decode(options, ...ciphertexts.split("\n")));
  assertEquals(decoded, plaintexts.join("\n"));
});

