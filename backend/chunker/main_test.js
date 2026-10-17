import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { backendSuite } from "../../lib/testing/suite.js";
import { remote } from "../../lib/testing/remote.js";
import backend from "./main.js";

// Small chunks, thus the files of the suite have more than one chunk.
const CHUNK = "64k";

backendSuite("chunker", backend, {
  params: { remote: ":memory:/chunker", chunk_size: CHUNK },
});
// Without metadata, a name is always in chunks. rclone does not read the
// name of a chunk with "\n": "." of Go does not match it.
backendSuite("chunker meta_format=none", backend, {
  params: {
    remote: ":memory:/none",
    chunk_size: CHUNK,
    meta_format: "none",
    hash_type: "none",
  },
  skipName: /\n/,
});
backendSuite("chunker transactions=norename", backend, {
  params: {
    remote: ":memory:/norename",
    chunk_size: CHUNK,
    transactions: "norename",
  },
});

/** @param {number} size */
function content(size) {
  return new Uint8Array(size).map((_, index) => (index * 7 + 3) & 0xff);
}

describe("chunker", () => {
  const root = ":memory:/layout";
  const fs = remote(backend, { params: { remote: root, chunk_size: "1k" } });

  /** The names of the files on the remote under the chunker. */
  async function layout(path = "") {
    const response = await globalThis.fetch(`${root}/${path}`);
    const html = await response.text();
    return [...html.matchAll(/<a href="([^"?]+)/g)]
      .map(([, href]) => decodeURIComponent(href))
      .filter((name) => name !== "../")
      .sort();
  }

  /** @param {string} path */
  async function text(path) {
    return await globalThis.fetch(`${root}/${path}`).then((r) => r.text());
  }

  test("puts a small file as it is, and a large file in chunks", async () => {
    await fs.put("small.bin", content(1024));
    await fs.put("large.bin", content(2500));
    assert.deepEqual(await layout(), [
      "large.bin",
      "large.bin.rclone_chunk.001",
      "large.bin.rclone_chunk.002",
      "large.bin.rclone_chunk.003",
      "small.bin",
    ]);
    const md5 = createHash("md5").update(content(2500)).digest("hex");
    assert.equal(
      await text("large.bin"),
      `{"ver":1,"size":2500,"nchunks":3,"md5":"${md5}"}`,
    );
  });

  test("removes the old chunks when a file changes", async () => {
    await fs.put("large.bin", content(1500));
    assert.deepEqual(
      (await layout()).filter((name) => name.startsWith("large")),
      [
        "large.bin",
        "large.bin.rclone_chunk.001",
        "large.bin.rclone_chunk.002",
      ],
    );
    await fs.put("large.bin", content(10));
    assert.deepEqual(
      (await layout()).filter((name) => name.startsWith("large")),
      [
        "large.bin",
      ],
    );
    await fs.delete("large.bin");
    await fs.delete("small.bin");
    assert.deepEqual(await layout(), []);
  });

  test("puts a file of unknown size in chunks with metadata", async () => {
    const data = content(3000);
    const body = new Blob([data]).stream();
    const response = await fs.send("stream.bin", {
      method: "PUT",
      body,
      duplex: "half",
    });
    assert.equal(response.status, 201);
    assert.deepEqual((await layout()).length, 4);
    const back = await fs.get("stream.bin");
    assert.deepEqual(new Uint8Array(await back.arrayBuffer()), data);
    await fs.delete("stream.bin");
  });

  test("keeps a small file with the content of metadata in a chunk", async () => {
    const fake = new TextEncoder().encode(`{"ver":1,"size":5,"nchunks":1}`);
    await fs.put("fake.json", fake);
    assert.deepEqual(await layout(), [
      "fake.json",
      "fake.json.rclone_chunk.001",
    ]);
    const back = await fs.get("fake.json");
    assert.deepEqual(new Uint8Array(await back.arrayBuffer()), fake);
    await fs.delete("fake.json");
  });

  test("hides a file with a missing chunk", async () => {
    await fs.put("broken.bin", content(2500));
    await globalThis.fetch(`${root}/broken.bin.rclone_chunk.002`, {
      method: "DELETE",
    });
    assert.deepEqual(await fs.list(""), []);
    const response = await fs.get("broken.bin");
    assert.equal(response.status, 500);
    await fs.delete("broken.bin");
  });

  test("gives 400 for options that rclone refuses", async () => {
    for (
      const params of [
        {},
        { remote: root, chunk_size: "1q" },
        { remote: root, name_format: "no-asterisk.#" },
        { remote: root, name_format: "*.chunk" },
        { remote: root, meta_format: "xml" },
        { remote: root, hash_type: "crc" },
        { remote: root, meta_format: "none" },
        {
          remote: root,
          meta_format: "none",
          hash_type: "none",
          transactions: "norename",
        },
      ]
    ) {
      const response = await remote(backend, { params }).get("");
      assert.equal(response.status, 400, JSON.stringify(params));
    }
  });

  test("names the chunks with name_format and start_from", async () => {
    const custom = remote(backend, {
      params: {
        remote: root,
        chunk_size: "1k",
        name_format: "*.part#",
        start_from: "0",
      },
    });
    await custom.put("a.bin", content(2048 + 1));
    assert.deepEqual(await layout(), [
      "a.bin",
      "a.bin.part0",
      "a.bin.part1",
      "a.bin.part2",
    ]);
    assert.equal((await custom.list(""))[0].Size, 2049);
    await custom.delete("a.bin");
  });
});
