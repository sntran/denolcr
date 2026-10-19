import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { isOneRange, parseRange, sliceStream } from "./range.js";

test("parseRange reads one range of bytes", () => {
  const size = 1000;
  for (
    const [header, range] of [
      ["bytes=0-0", { start: 0, end: 0 }],
      ["bytes=0-99", { start: 0, end: 99 }],
      ["bytes=100-", { start: 100, end: 999 }],
      ["bytes=999-", { start: 999, end: 999 }],
      ["bytes=500-5000", { start: 500, end: 999 }],
      ["bytes=-1", { start: 999, end: 999 }],
      ["bytes=-100", { start: 900, end: 999 }],
      ["bytes=-5000", { start: 0, end: 999 }],
      ["Bytes=1-2", { start: 1, end: 2 }],
      [" bytes=1-2 ", { start: 1, end: 2 }],
    ]
  ) {
    assert.deepEqual(parseRange(header, size), range, header);
  }
});

test("parseRange gives null to send all the file", () => {
  for (
    const header of [
      null,
      "",
      "bytes=",
      "bytes=-",
      "bytes=5-1",
      "bytes=0-1,5-6",
      "items=0-1",
      "bytes=a-b",
      "bytes=1.5-2",
    ]
  ) {
    assert.equal(parseRange(header, 1000), null, JSON.stringify(header));
  }
});

test("parseRange throws when no byte is in the range", () => {
  for (
    const [header, size] of [
      ["bytes=1000-", 1000],
      ["bytes=1000-2000", 1000],
      ["bytes=-0", 1000],
      ["bytes=0-", 0],
      ["bytes=-1", 0],
    ]
  ) {
    assert.throws(() => parseRange(header, size), RangeError, header);
  }
});

test("sliceStream gives the bytes of the part, for any chunks", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 300 }),
      fc.array(fc.nat(50), { maxLength: 20 }),
      fc.nat(320),
      fc.nat(320),
      async (data, cuts, skip, length) => {
        // The data in chunks of the sizes of `cuts`, then the rest.
        const chunks = [];
        let offset = 0;
        for (const cut of cuts) {
          chunks.push(data.subarray(offset, offset + cut));
          offset += cut;
        }
        chunks.push(data.subarray(offset));
        const part = sliceStream(ReadableStream.from(chunks), skip, length);
        const bytes = new Uint8Array(await new Response(part).arrayBuffer());
        assert.deepEqual(bytes, data.slice(skip, skip + length));
      },
    ),
  );
});

test("isOneRange tells the ranges that a server can get", () => {
  for (const header of ["bytes=0-0", "bytes=5-", "bytes=-1", "bytes=-0"]) {
    assert.ok(isOneRange(header), header);
  }
  for (
    const header of [
      null,
      "",
      "bytes=5-1",
      "bytes=0-1,5-6",
      "items=0-1",
      "bytes=-",
    ]
  ) {
    assert.ok(!isOneRange(header), String(header));
  }
});
