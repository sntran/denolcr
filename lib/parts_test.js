import { test } from "node:test";
import assert from "node:assert/strict";

import { Parts } from "./parts.js";

/**
 * A stream of the bytes, in chunks of the sizes.
 * @param {Uint8Array} bytes
 * @param {number[]} sizes
 */
function chunked(bytes, sizes) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const size = sizes[offset % sizes.length] || 1;
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

test("Parts cuts a stream into parts of the size, for any chunks", async () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 251);
  for (const sizes of [[1], [7], [100], [1000], [3, 500, 1]]) {
    for (const size of [1, 10, 333, 1000, 2000]) {
      const parts = new Parts(chunked(bytes, sizes), size);
      const all = [];
      for (let part = await parts.next(); part; part = await parts.next()) {
        all.push(part);
        if (parts.done) break;
      }
      assert.deepEqual(
        all.map((part) => part.length),
        Array.from(
          { length: Math.ceil(bytes.length / size) },
          (_, i) => Math.min(size, bytes.length - i * size),
        ),
        `chunks ${sizes}, parts of ${size}`,
      );
      assert.deepEqual(new Uint8Array(all.flatMap((part) => [...part])), bytes);
      assert.equal(parts.done, true);
    }
  }
});

test("Parts gives no part for an empty stream", async () => {
  const parts = new Parts(new Blob([]).stream(), 10);
  assert.equal(await parts.next(), null);
});
