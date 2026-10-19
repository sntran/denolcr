import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRange, partialHeaders } from "./range.js";
import { RangedFile, RemoteError } from "./ranged.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A file of a remote, with or with no support of ranges.
 * @param {string} text
 * @param {{ ranges?: boolean }} [options]
 */
function fileOf(text, { ranges = true } = {}) {
  const bytes = encoder.encode(text);
  /** @type {string[]} */
  const requests = [];
  const file = new RangedFile((headers) => {
    const header = headers.get("Range");
    requests.push(header);
    let range = null;
    try {
      range = ranges ? parseRange(header, bytes.length) : null;
    } catch {
      return Promise.resolve(
        new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${bytes.length}` },
        }),
      );
    }
    if (!range) {
      return Promise.resolve(
        new Response(bytes, {
          headers: { "Content-Length": `${bytes.length}` },
        }),
      );
    }
    return Promise.resolve(
      new Response(bytes.subarray(range.start, range.end + 1), {
        status: 206,
        headers: partialHeaders(range, bytes.length),
      }),
    );
  });
  return { file, requests };
}

test("RangedFile reads the end, a part and a stream of a file", async () => {
  const { file, requests } = fileOf("0123456789");
  assert.equal(decoder.decode(await file.tail(3)), "789");
  assert.equal(file.size, 10);
  assert.equal(decoder.decode(await file.read(2, 4)), "2345");
  const stream = await file.stream(5, 3);
  assert.equal(await new Response(stream).text(), "567");
  assert.deepEqual(requests, ["bytes=-3", "bytes=2-5", "bytes=5-7"]);
  // The end of a file that is smaller than the part.
  assert.equal(decoder.decode(await file.tail(100)), "0123456789");
  assert.equal(decoder.decode(await file.read(8, 10)), "89");
  assert.equal((await file.read(20, 5)).length, 0);
});

test("RangedFile reads a small file of a remote with no ranges", async () => {
  const { file } = fileOf("0123456789", { ranges: false });
  assert.equal(decoder.decode(await file.tail(100)), "0123456789");
  assert.equal(file.size, 10);
  assert.equal(decoder.decode(await file.read(2, 8)), "23456789");
  const stream = await file.stream(4, 2);
  assert.equal(await new Response(stream).text(), "45");
  // A file that is larger than the part does not come into memory.
  await assert.rejects(file.tail(3), (error) => {
    assert.ok(error instanceof RemoteError);
    assert.equal(error.response.status, 501);
    return true;
  });
});

test("RangedFile gives the answer of the remote for an error", async () => {
  const file = new RangedFile(() =>
    Promise.resolve(new Response("object not found", { status: 404 }))
  );
  const error = await file.tail(10).catch((error) => error);
  assert.ok(error instanceof RemoteError);
  assert.equal(error.response.status, 404);
  assert.equal(await error.response.text(), "object not found");
});

test("RangedFile reads an empty file", async () => {
  const { file } = fileOf("");
  assert.equal((await file.tail(10)).length, 0);
  assert.equal(file.size, 0);
});
