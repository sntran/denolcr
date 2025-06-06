import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { contentType, extname, join } from "../../deps.js";
import { assert, assertEquals, equalBytes, fc } from "../../dev_deps.js";

import { decode, default as crypt, encode } from "./main.js";

const PASSWORD = "UmyLSdRHfew6aual28-ggx78qHqSfQ";
const SALT = "Cj3gLa5PVwc2aot0QpKiOZ3YEzs3Sw";

const fixtures = new URL(join(".", "fixtures"), import.meta.url).pathname;

const CRYPT = {
  "hello.txt": "7656ki2d7s0mgv9ci91hnq77k8",
  "rclone.png": "mtnq34s46g5ntbnut5ftn4r2dc",
  "1MB.bin": "k6ki5t8t5e5h3qoq78mpd29pns",
};

const MAGIC = new TextEncoder().encode("RCLONE\x00\x00");

/**
 * @param {Response | Promise<Response>} response
 * @returns
 */
async function getText(response) {
  response = await response;
  const text = await response.text();
  return text.replace(/\n$/, "");
}

test("decode", async () => {
  const options = {
    password: PASSWORD,
    password2: SALT,
  };

  for await (const originalFilename of Object.keys(CRYPT)) {
    const decoded = await getText(encode(options, originalFilename));
    assertEquals(decoded, CRYPT[originalFilename]);
  }
});

test("encode", async () => {
  const options = {
    password: PASSWORD,
    password2: SALT,
  };

  /**
   * @type {string[]}
   */
  const plaintexts = [];

  // Tests property that decoding an encoded string should return the original string.
  // Instead of calling `encode/decode` for individual property values, which consumes
  // lots of time due to getting the key, we collect the generated plaintexts and then
  // encode them all at once.
  fc.assert(
    fc.property(fc.string(), (plaintext) => {
      plaintexts.push(plaintext);
    }),
  );

  // Encodes all plaintexts into ciphertexts separated by newlines.
  const ciphertexts = await getText(encode(options, ...plaintexts));
  // Decodes all ciphertexts into plaintexts separated by newlines.
  const decoded = await getText(decode(options, ...ciphertexts.split("\n")));
  assertEquals(decoded, plaintexts.join("\n"));
});

test("GET", async (t) => {
  const remote = join(fixtures, "crypt");
  let request, response;

  await t.test("should return original file", async () => {
    for await (const originalFilename of Object.keys(CRYPT)) {
      const originalFile = await readFile(
        join(fixtures, "local", originalFilename),
      );
      const url = new URL(`/${originalFilename}`, "file:");
      url.searchParams.set("remote", remote);
      url.searchParams.set("password", PASSWORD);
      url.searchParams.set("password2", SALT);

      request = new Request(url);
      response = await crypt.fetch(request);

      const decryptedFile = new Uint8Array(await response.arrayBuffer());
      assert(equalBytes(decryptedFile, originalFile));
    }
  });

  await t.test("should return original file info in headers", async () => {
    for await (const originalFilename of Object.keys(CRYPT)) {
      const originalFile = await readFile(
        join(fixtures, "local", originalFilename),
      );
      const url = new URL(`/${originalFilename}`, "file:");
      url.searchParams.set("remote", remote);
      url.searchParams.set("password", PASSWORD);
      url.searchParams.set("password2", SALT);

      request = new Request(url);
      response = await crypt.fetch(request);

      const size = Number(response.headers.get("Content-Length"));
      assertEquals(size, originalFile.byteLength);

      const type = response.headers.get("Content-Type");
      assertEquals(type, contentType(extname(originalFilename)));

      response.body?.cancel();
    }
  });
});

test("PUT", async () => {
  const remote = ":memory:";

  for await (const originalFilename of Object.keys(CRYPT)) {
    const originalFile = await readFile(
      join(fixtures, "local", originalFilename),
    );

    const encryptedFilename = CRYPT[originalFilename];
    const url = new URL(`/${originalFilename}`, "file:");
    url.searchParams.set("remote", remote);
    url.searchParams.set("password", PASSWORD);
    url.searchParams.set("password2", SALT);

    let request, response;

    // Asserts file does not exist in the original remote.
    response = await fetch(join(remote, originalFilename));
    assertEquals(response.status, 404);

    response = await fetch(join(remote, encryptedFilename));
    assertEquals(response.status, 404);

    // Uploads the file to the crypt remote.
    request = new Request(url, {
      method: "PUT",
      body: originalFile,
    });
    response = await crypt.fetch(request);

    // Asserts original file does not exist in the original remote.
    response = await fetch(join(remote, originalFilename));
    assertEquals(response.status, 404);

    // Asserts encrypted file exists in the original remote.
    response = await fetch(join(remote, encryptedFilename));
    assertEquals(response.status, 200);
    const encryptedBuffer = new Uint8Array(await response.arrayBuffer());
    assert(!equalBytes(encryptedBuffer, originalFile));

    const magic = encryptedBuffer.subarray(0, 8);
    assertEquals(magic, MAGIC, "should have magic header");

    // Gets the new file from the crypt remote.
    request = new Request(url);
    response = await crypt.fetch(request);
    const decryptedFile = new Uint8Array(await response.arrayBuffer());
    assert(equalBytes(decryptedFile, originalFile));
  }
});
