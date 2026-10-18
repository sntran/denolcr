import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { CHUNK, htmlRewriter, inChunks } from "./rewriter.js";
import { readListing, renderListing } from "./listing.js";

/** @param {Uint8Array[]} chunks */
function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** @param {ReadableStream<Uint8Array>} stream */
async function chunksOf(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** @param {Uint8Array[]} chunks */
function join(chunks) {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

test("inChunks gives the same bytes in chunks of at most CHUNK bytes", async () => {
  const sizes = fc.oneof(
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: CHUNK - 100, max: CHUNK + 100 }),
    fc.integer({ min: 0, max: 4 * CHUNK }),
  );
  await fc.assert(
    fc.asyncProperty(fc.array(sizes, { maxLength: 30 }), async (lengths) => {
      let byte = 0;
      const input = lengths.map((length) =>
        Uint8Array.from({ length }, () => byte++ % 251)
      );
      const output = await chunksOf(inChunks(streamOf(input)));
      assert.deepEqual(join(output), join(input));
      for (const [index, chunk] of output.entries()) {
        assert.ok(chunk.length > 0, "an empty chunk");
        assert.ok(chunk.length <= CHUNK, `a chunk of ${chunk.length} bytes`);
        // Two chunks one after the other that fit in one chunk are one.
        const next = output[index + 1];
        if (next) assert.ok(chunk.length + next.length > CHUNK);
      }
    }),
  );
});

test("htmlRewriter gives the output of each cut of the HTML", async () => {
  const html = new TextEncoder().encode(
    `<table>${"<tr><td><a href='a é.txt'>a é</a></td></tr>".repeat(500)}`,
  );
  /** @param {Uint8Array[]} chunks */
  const transform = async (chunks) => {
    const rewriter = await htmlRewriter();
    const response = rewriter
      .on("a[href]", {
        element(element) {
          element.setAttribute("href", "b.txt");
        },
      })
      .transform(new Response(streamOf(chunks)));
    return await response.text();
  };
  const expected = (await transform([html])).replaceAll("a é.txt", "b.txt");
  assert.ok(!expected.includes("a é.txt"));
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: html.length - 1 }), {
        maxLength: 40,
      }),
      async (cuts) => {
        const points = [0, ...cuts.toSorted((a, b) => a - b), html.length];
        const chunks = points.slice(1).map((end, index) =>
          html.subarray(points[index], end)
        );
        assert.equal(await transform(chunks), expected);
      },
    ),
    { numRuns: 20 },
  );
});

test("readListing reads a list of many chunks of CHUNK bytes, in one chunk", async () => {
  const entries = Array.from({ length: 2000 }, (_, index) => ({
    Name: `file ${index}.txt`,
    IsDir: false,
    Size: index,
    MimeType: "text/plain",
    ModTime: "2026-10-18T12:00:00.000Z",
  }));
  const html = await new Response(renderListing(entries)).arrayBuffer();
  assert.ok(html.byteLength > 10 * CHUNK);
  const list = await readListing(
    new Response(new Uint8Array(html)),
    new URL("http://remote/folder/"),
  );
  assert.equal(list.length, entries.length);
  assert.deepEqual(
    list.toSorted((a, b) => a.Size - b.Size),
    entries,
  );
});
