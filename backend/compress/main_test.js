import { test } from "node:test";
import assert from "node:assert/strict";

import { backendSuite } from "@rfetch/lib/testing/suite";
import { remote } from "@rfetch/lib/testing/remote";
// Sets the global `fetch` that reads the paths of remotes.
import { fetch } from "../../mod.js";
import backend, { dataName, fileOf, sizeName } from "./main.js";
import { BLOCK_SIZE, blocksFor, GzipStream, isCompressible } from "./gzip.js";

const encoder = new TextEncoder();

backendSuite("compress", backend, {
  type: "compress",
  params: { remote: ":memory:/compress" },
  features: { dirMove: true },
});
// The data in gzip are compressed.
backendSuite("compress", backend, {
  params: { remote: ":memory:/compress-6", level: "6" },
  features: { dirMove: true },
});

/** Text that compresses, of a size. @param {number} size */
function text(size) {
  const line = encoder.encode("a line of text that compresses well\n");
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += line.length) {
    bytes.set(line.subarray(0, size - offset), offset);
  }
  return bytes;
}

/** Bytes that do not compress. @param {number} size */
function random(size) {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
  }
  return bytes;
}

/** The names of the files in a folder of memory. @param {string} folder */
async function namesIn(folder) {
  const html = await fetch(`${folder}/`).then((response) => response.text());
  return [...html.matchAll(/<a href="([^"?]+)/g)].map(([, href]) =>
    decodeURIComponent(href)
  ).filter((name) => name !== "../").sort();
}

test("the names of the data are the names of rclone", () => {
  // A file of rclone 1.75: text.txt of 2888890 bytes.
  assert.equal(sizeName(2888890), "uhQsAAAAAAA");
  assert.equal(dataName("a/text.txt", 2888890, 2), "a/text.txt.uhQsAAAAAAA.gz");
  assert.equal(dataName("a/text.txt", 2888890, 0), "a/text.txt.bin");
  assert.equal(dataName("a.txt", 5, 4), `a.txt.${sizeName(5)}.zst`);
  assert.deepEqual(fileOf("text.txt.uhQsAAAAAAA.gz"), {
    name: "text.txt",
    size: 2888890,
  });
  assert.deepEqual(fileOf("random.bin.bin"), {
    name: "random.bin",
    size: null,
  });
  assert.deepEqual(fileOf("a.b.c.AAAAAAAAAAA.gz"), { name: "a.b.c", size: 0 });
  assert.equal(fileOf("no-extension"), null);
  assert.equal(fileOf("short.ABC.gz"), null);
});

test("GzipStream writes gzip in blocks, with their sizes", async () => {
  for (const size of [0, 1, BLOCK_SIZE, BLOCK_SIZE * 2 + 3]) {
    const data = text(size);
    const gzip = new GzipStream(6);
    const compressed = new Uint8Array(
      await new Response(new Blob([data]).stream().pipeThrough(gzip))
        .arrayBuffer(),
    );
    const { BlockSize, Size, BlockData } = gzip.metadata;
    assert.equal(BlockSize, BLOCK_SIZE);
    assert.equal(Size, size);
    // The header, then the blocks, then the trailer of 8 bytes.
    assert.equal(BlockData[0], 10);
    assert.equal(
      BlockData.reduce((sum, length) => sum + length, 0),
      compressed.length - 8,
      `${size}`,
    );
    const back = new Uint8Array(
      await new Response(
        new Blob([compressed]).stream().pipeThrough(
          new DecompressionStream("gzip"),
        ),
      ).arrayBuffer(),
    );
    assert.deepEqual(back, data, `${size}`);
  }
});

test("isCompressible decides as rclone for small files", () => {
  /** @param {string} value @param {number} length */
  const sample = (value, length) =>
    encoder.encode(value.repeat(length).slice(0, length));
  // The decisions of rclone 1.75.1 for these files.
  for (
    const [value, length, compressible] of [
      ["", 0, false],
      ["\0", 32, false],
      ["\0", 75, false],
      ["\0", 76, true],
      ["ab", 81, false],
      ["ab", 82, true],
      ["hello ", 48, false],
      ["hello ", 90, false],
      ["hello ", 200, true],
    ]
  ) {
    assert.equal(
      isCompressible(sample(value, length)),
      compressible,
      `${JSON.stringify(value)} ${length}`,
    );
  }
  assert.equal(isCompressible(text(10000)), true);
  assert.equal(isCompressible(random(10000)), false);
});

test("blocksFor gives the compressed data from the block of a byte", () => {
  const metadata = { BlockSize: 100, Size: 250, BlockData: [10, 20, 30, 40] };
  assert.deepEqual(blocksFor(metadata, 0), { from: 10, to: 99, skip: 0 });
  assert.deepEqual(blocksFor(metadata, 150), { from: 30, to: 99, skip: 50 });
  assert.deepEqual(blocksFor(metadata, 249), { from: 60, to: 99, skip: 49 });
  assert.equal(blocksFor({ BlockSize: 0, Size: 0, BlockData: null }, 0), null);
});

test("compress reads ranges in each block of a large file", async () => {
  const fs = remote(backend, {
    params: { remote: ":memory:/compress-ranges", level: "6" },
  });
  const data = text(BLOCK_SIZE * 3 + 12345);
  assert.equal((await fs.put("big.txt", data)).status, 201);
  for (
    const [start, end] of [
      [0, 99],
      [BLOCK_SIZE - 5, BLOCK_SIZE + 5],
      [BLOCK_SIZE * 2 + 7, BLOCK_SIZE * 3 + 100],
      [data.length - 10, data.length - 1],
    ]
  ) {
    const response = await fs.get("big.txt", {
      Range: `bytes=${start}-${end}`,
    });
    assert.equal(response.status, 206);
    assert.equal(
      response.headers.get("Content-Range"),
      `bytes ${start}-${end}/${data.length}`,
    );
    const part = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(part, data.subarray(start, end + 1), `${start}-${end}`);
  }
  const all = new Uint8Array(
    await fs.get("big.txt").then((r) => r.arrayBuffer()),
  );
  assert.deepEqual(all, data);
});

test("compress keeps a file that does not compress as .bin", async () => {
  const fs = remote(backend, { params: { remote: ":memory:/compress-bin" } });
  await fs.put("random.dat", random(5000));
  await fs.put("small.txt", encoder.encode("hello\n"));
  await fs.put("text.txt", text(10000));
  assert.deepEqual(await namesIn(":memory:/compress-bin"), [
    "random.dat.bin",
    "random.dat.json",
    "small.txt.bin",
    "small.txt.json",
    `text.txt.${sizeName(10000)}.gz`,
    "text.txt.json",
  ]);
  const metadata = await fetch(":memory:/compress-bin/text.txt.json")
    .then((response) => response.json());
  assert.deepEqual(Object.keys(metadata), [
    "Mode",
    "Size",
    "MD5",
    "MimeType",
    "CompressionMetadataGzip",
    "CompressionMetadataZstd",
  ]);
  assert.equal(metadata.Mode, 2);
  assert.equal(metadata.MimeType, "text/plain; charset=utf-8");
  const random_ = await fetch(":memory:/compress-bin/random.dat.json")
    .then((response) => response.json());
  assert.equal(random_.MimeType, "application/octet-stream");
  // As the other backends, compress gives the type of the name.
  const head = await fs.head("text.txt");
  assert.equal(head.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.equal(head.headers.get("Content-Length"), "10000");
});

test("compress writes a file with no Content-Length", async () => {
  const fs = remote(backend, {
    params: { remote: ":memory:/compress-stream" },
  });
  const data = text(3000);
  const body = new Blob([data]).stream();
  const response = await fs.send("streamed.txt", { method: "PUT", body });
  assert.equal(response.status, 201);
  assert.deepEqual(
    await namesIn(":memory:/compress-stream"),
    [`streamed.txt.${sizeName(3000)}.gz`, "streamed.txt.json"].sort(),
  );
  const back = new Uint8Array(
    await fs.get("streamed.txt").then((r) => r.arrayBuffer()),
  );
  assert.deepEqual(back, data);
});

test("a change of a file deletes the data of its old size", async () => {
  const fs = remote(backend, {
    params: { remote: ":memory:/compress-change" },
  });
  await fs.put("f.txt", text(2000));
  await fs.put("f.txt", text(3000));
  assert.deepEqual(
    await namesIn(":memory:/compress-change"),
    [`f.txt.${sizeName(3000)}.gz`, "f.txt.json"].sort(),
  );
  await fs.put("f.txt", random(3000));
  assert.deepEqual(await namesIn(":memory:/compress-change"), [
    "f.txt.bin",
    "f.txt.json",
  ]);
  assert.equal((await fs.delete("f.txt")).status, 204);
  assert.deepEqual(await namesIn(":memory:/compress-change"), []);
});

test("compress gives the errors of its options", async () => {
  const bad = remote(backend, {
    params: { remote: ":memory:/compress-errors", level: "10" },
  });
  const response = await bad.put("a.txt", text(100));
  assert.equal(response.status, 400);
  assert.equal(await response.text(), "gzip: invalid compression level: 10");
  const zstd = remote(backend, {
    params: { remote: ":memory:/compress-errors", mode: "zstd" },
  });
  assert.equal((await zstd.put("a.txt", text(100))).status, 501);
  const none = remote(backend, {});
  assert.equal((await none.get("")).status, 400);
});

test("with a mode that is not gzip, compress does not compress", async () => {
  const fs = remote(backend, {
    params: { remote: ":memory:/compress-none", mode: "none" },
  });
  await fs.put("text.txt", text(10000));
  assert.deepEqual(await namesIn(":memory:/compress-none"), [
    "text.txt.bin",
    "text.txt.json",
  ]);
});
