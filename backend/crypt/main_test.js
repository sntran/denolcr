import { describe, test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import fc from "fast-check";

import { backendSuite } from "../../lib/testing/suite.js";
import { remote } from "../../lib/testing/remote.js";
import { fetch } from "../../mod.js";
import { mimeType } from "../../lib/mime.js";
import { decode, default as crypt, deriveKey, encode } from "./main.js";

/** The remotes under the backend, through the fetch of rfetch. */
const env = { REMOTE: { fetch } };

// The password "123456" and the salt, obscured.
const PASSWORD = "UmyLSdRHfew6aual28-ggx78qHqSfQ";
const SALT = "Cj3gLa5PVwc2aot0QpKiOZ3YEzs3Sw";

// The tests read the fixtures from the current folder. Each test file runs in
// its own process.
const fixtures = new URL(join(".", "fixtures"), import.meta.url).pathname;
process.chdir(fixtures);

const CRYPT = {
  "hello.txt": "7656ki2d7s0mgv9ci91hnq77k8",
  "rclone.png": "mtnq34s46g5ntbnut5ftn4r2dc",
  "1MB.bin": "k6ki5t8t5e5h3qoq78mpd29pns",
};

/**
 * @param {Response | Promise<Response>} response
 * @returns
 */
async function getText(response) {
  response = await response;
  const text = await response.text();
  return text.replace(/\n$/, "");
}

test("makes the keys of rclone (TestKey)", async () => {
  const hex = (bytes) => Buffer.from(bytes).toString("hex");
  for (
    const [password, salt, dataKey, nameKey, nameTweak] of [
      [
        "potato",
        "",
        "7455c71ab17c865b8471f47b79acb07eb31d5678b80c7e2eaf4fc8066a9ee468",
        "765da27ab15d77f95796711f7b93ad63bbb484072e7180a8d17a9bbec14270d0",
        "c18d5932f55b2828c5e1e87215520310",
      ],
      [
        "Potato",
        "",
        "aeea6ad347df75b963ce12f57623e946d42ed8bf3e928b39243794133e5ef75e",
        "54f7026e8afc560a86636aab2c9c5162e51a122351836eaf50420f981c860a19",
        "f8c1b6272d529b4a8fdaeb424a28ddf3",
      ],
      [
        "potato",
        "sausage",
        "8e9b6b99f8690467a071f9cb92d0aa787f8ff178bec96f999fd5206e644a1b50",
        "3ea95ef681782dc9d9955d225bfd442c6f5d6897b029015c6f462e2a9dae2ce3",
        "f17fd7141d65274f363fc2a04dd2148a",
      ],
      [
        "potato",
        "Sausage",
        "da818c67ef110fc8d5c8624b7fe29e3535b08d798489accba0ff0272031a5e64",
        "02817e7bea99815ad02db96448b028277c20b4d4a468ad4e5c290f79efeedb3b",
        "9ab50b3dcb605955a54de6b6470323e2",
      ],
      ["", "", "00".repeat(32), "00".repeat(32), "00".repeat(16)],
    ]
  ) {
    const key = await deriveKey(password, salt);
    assert.equal(hex(key.subarray(0, 32)), dataKey, password);
    assert.equal(hex(key.subarray(32, 64)), nameKey, password);
    assert.equal(hex(key.subarray(64)), nameTweak, password);
  }
});

test("decode", async () => {
  const options = {
    password: PASSWORD,
    password2: SALT,
  };

  for await (const originalFilename of Object.keys(CRYPT)) {
    const decoded = await getText(encode(options, originalFilename));
    assert.deepEqual(decoded, CRYPT[originalFilename]);
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
      fc.pre(!plaintext.includes("\n"));
      plaintexts.push(plaintext);
    }),
  );

  // Encodes all plaintexts into ciphertexts separated by newlines.
  const ciphertexts = await getText(encode(options, ...plaintexts));
  // Decodes all ciphertexts into plaintexts separated by newlines.
  const decoded = await getText(decode(options, ...ciphertexts.split("\n")));
  assert.deepEqual(decoded, plaintexts.join("\n"));
});

test("GET of the fixtures", async () => {
  const fs = remote(crypt, {
    env,
    params: { remote: "crypt", password: PASSWORD, password2: SALT },
  });
  for (const name of Object.keys(CRYPT)) {
    const original = await readFile(join("local", name));
    const response = await fs.get(name);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), mimeType(name));
    assert.equal(
      response.headers.get("Content-Length"),
      `${original.byteLength}`,
    );
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      new Uint8Array(original),
    );
  }
});

const params = {
  remote: ":memory:/crypt",
  password: PASSWORD,
  password2: SALT,
};

backendSuite("crypt", crypt, { env, params });

describe("crypt", () => {
  const fs = remote(crypt, { env, params });

  test("puts no password in the links of a list", async () => {
    await fs.put("secret/a b.txt", new TextEncoder().encode("a"));
    for (const path of ["", "secret/"]) {
      const html = await fs.get(path).then((response) => response.text());
      assert.ok(html.includes(` href="a%20b.txt?`) || path === "");
      assert.ok(!html.includes(PASSWORD), "no password");
      assert.ok(!html.includes(SALT), "no salt");
      assert.ok(html.includes("remote="), "the other options stay");
    }
    await fs.delete("secret/");
  });

  test("lists no file with a name that does not decrypt", async () => {
    // A file that is not encrypted, next to the encrypted files.
    await fetch(":memory:/crypt/plain.txt", {
      method: "PUT",
      body: "plain",
    });
    await fs.put("encrypted.txt", new TextEncoder().encode("e"));
    const names = (await fs.list("")).map(({ Name }) => Name);
    assert.ok(names.includes("encrypted.txt"));
    assert.ok(!names.includes("plain.txt"));
    assert.equal(names.length, 1);
    await fs.delete("encrypted.txt");
    await fetch(":memory:/crypt/plain.txt", { method: "DELETE" });
  });

  test("gives 400 for a password that is not obscured", async () => {
    const bad = remote(crypt, { env, params: { ...params, password: "!!" } });
    const response = await bad.get("");
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes("!!"));
  });

  test("gives an error of the stream for data that is not encrypted", async () => {
    const encrypted = await getText(
      encode({ password: PASSWORD, password2: SALT }, "plain2.txt"),
    );
    // The name is encrypted, but the data is not.
    await fetch(`:memory:/crypt/${encrypted}`, {
      method: "PUT",
      body: "not encrypted data, longer than a header of 32 bytes",
    });
    const response = await fs.get("plain2.txt");
    await assert.rejects(response.arrayBuffer(), /bad magic/);
  });

  /** A file of 3 blocks and a part of a block. */
  const content = new Uint8Array(3 * 65536 + 100).map((_, i) => i * 7 + 1);

  test("reads only the header and the blocks of a range", async () => {
    /** The `Range` of each request to the remote. */
    const ranges = [];
    const counted = remote(crypt, {
      params,
      env: {
        REMOTE: {
          fetch(input, init = {}) {
            ranges.push(new Headers(init.headers).get("Range"));
            return fetch(input, init);
          },
        },
      },
    });
    await counted.put("blocks.bin", content);

    ranges.length = 0;
    const response = await counted.get("blocks.bin", {
      Range: "bytes=65536-65536",
    });
    assert.equal(response.status, 206);
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      content.subarray(65536, 65537),
    );
    // The header is 32 bytes, and a block is 65536 + 16 bytes.
    assert.deepEqual(ranges, ["bytes=0-31", "bytes=65584-131135"]);

    ranges.length = 0;
    const last = await counted.get("blocks.bin", { Range: "bytes=-1" });
    assert.deepEqual(
      new Uint8Array(await last.arrayBuffer()),
      content.subarray(-1),
    );
    const size = 32 + 3 * 65552 + 116;
    assert.deepEqual(ranges, ["bytes=0-31", `bytes=196688-${size - 1}`]);
  });

  test("gives a range when the remote sends all the file", async () => {
    // A remote that does not read the ranges.
    const full = remote(crypt, {
      params,
      env: {
        REMOTE: {
          fetch(input, init = {}) {
            const headers = new Headers(init.headers);
            headers.delete("Range");
            return fetch(input, { ...init, headers });
          },
        },
      },
    });
    await full.put("full.bin", content);
    for (
      const [header, start, end] of [["bytes=70000-140000", 70000, 140000]]
    ) {
      const response = await full.get("full.bin", { Range: header });
      assert.equal(response.status, 206);
      assert.equal(
        response.headers.get("Content-Range"),
        `bytes ${start}-${end}/${content.length}`,
      );
      assert.deepEqual(
        new Uint8Array(await response.arrayBuffer()),
        content.subarray(start, end + 1),
      );
    }
  });
});
