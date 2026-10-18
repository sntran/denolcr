import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { childOf, readListing, renderListing } from "./listing.js";

const base = new URL("http://remote/folder/");

/** @param {string} html */
const read = (html) => readListing(new Response(html), base);

test("readListing reads the list of renderListing", async () => {
  const entries = [
    {
      Name: "a b?#%.txt",
      IsDir: false,
      Size: 3,
      MimeType: "text/plain",
      ModTime: "2026-10-18T12:00:00.000Z",
    },
    { Name: "folder é", IsDir: true, Size: -1, MimeType: "", ModTime: "" },
    {
      Name: "<b>&amp;",
      IsDir: false,
      Size: 0,
      MimeType: "application/octet-stream",
      ModTime: "2026-10-18T12:00:01.000Z",
    },
  ];
  const html = await new Response(renderListing(entries, { query: "x=1" }))
    .text();
  const sorted = entries.toSorted((a, b) => a.Name.localeCompare(b.Name));
  assert.deepEqual(await read(html), sorted);
});

test("readListing reads only the links to the children of the folder", async () => {
  const html = `<table>
    <tr><td><a href="../">Go up</a></td></tr>
    <tr><td><a href="/other/a.txt">a</a></td></tr>
    <tr><td><a href="https://example.com/folder/b.txt">b</a></td></tr>
    <tr><td><a href="sub/c.txt">c</a></td></tr>
    <tr><td><a href="d.txt?x=1#y">d</a></td></tr>
  </table>`;
  assert.deepEqual((await read(html)).map(({ Name }) => Name), ["d.txt"]);
});

test("readListing gives one entry for each row, with the last link", async () => {
  const html = `<table>
    <tr><td><data value="7">7</data></td><td><a href="a.txt">a</a></td></tr>
    <tr><td><a href="b.txt">b</a><a href="c.txt" type="text/plain">c</a></td>
      <td><data value="5">5</data></td>
      <td><time datetime="2026-10-18T12:00:00Z">now</time></td></tr>
    <tr><td><a href="../">up</a></td><td><data value="9">9</data></td></tr>
    <tr><td><a href="e/">e/</a>
  </table>`;
  assert.deepEqual(await read(html), [
    { Name: "a.txt", IsDir: false, Size: -1, MimeType: "", ModTime: "" },
    {
      Name: "c.txt",
      IsDir: false,
      Size: 5,
      MimeType: "text/plain",
      ModTime: "2026-10-18T12:00:00Z",
    },
    { Name: "e", IsDir: true, Size: -1, MimeType: "", ModTime: "" },
  ]);
});

test("childOf gives the name of a child, or null", () => {
  assert.equal(childOf("a%20b.txt", base), "a b.txt");
  assert.equal(childOf("a/", base), "a/");
  assert.equal(childOf("a%2Fb", base), "a/b");
  assert.equal(childOf("../", base), null);
  assert.equal(childOf("a/b", base), null);
  assert.equal(childOf("%E0", base), null);
  assert.equal(childOf("//example.com/folder/a", base), null);
});

/**
 * A response with the bytes of a text in chunks, cut at the places.
 * @param {string} html
 * @param {number[]} cuts
 */
function inChunks(html, cuts) {
  const bytes = new TextEncoder().encode(html);
  const places = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))]
    .sort((a, b) => a - b);
  const chunks = [];
  let start = 0;
  for (const place of [...places, bytes.length]) {
    chunks.push(bytes.subarray(start, place));
    start = place;
  }
  return new Response(new Blob(chunks).stream());
}

test("readListing gives back the entries of renderListing", async () => {
  const entry = fc.record({
    // `.`, `..` and a name with `/` are not names of files: the link of `.`
    // is the folder, the link of `..` is its parent, and `/` is between two
    // names.
    Name: fc.fullUnicodeString({ minLength: 1, maxLength: 12 })
      .filter((name) => name !== "." && name !== ".." && !name.includes("/")),
    IsDir: fc.boolean(),
    Size: fc.nat(),
    MimeType: fc.constantFrom("", "text/plain; charset=utf-8", "image/png"),
    ModTime: fc.constantFrom(
      "",
      "2026-10-18T12:00:00.000Z",
      "2026-10-18T15:02:41.540476887Z",
    ),
  });
  await fc.assert(
    fc.asyncProperty(
      fc.array(entry, { maxLength: 20 }),
      fc.constantFrom("", "a=1&b=%3C"),
      // The places where the HTML is cut into chunks.
      fc.array(fc.nat(), { maxLength: 8 }),
      async (entries, query, cuts) => {
        const html = await new Response(renderListing(entries, { query }))
          .text();
        const expected = entries
          .toSorted((a, b) => a.Name.localeCompare(b.Name))
          .map((entry) =>
            entry.IsDir ? { ...entry, Size: -1, MimeType: "" } : entry
          );
        assert.deepEqual(
          await readListing(inChunks(html, cuts), base),
          expected,
        );
      },
    ),
    { numRuns: 50 },
  );
});

test("readListing reads HTML as the HTML standard tells", async () => {
  const html = `<TABLE><tr><td><A HREF='q.txt' type=text/plain TYPE="x">q</A>
    <a href=r&amp;s.txt>r</a></td><td><DATA value="12">12</DATA></td></tr>
    <tr><script>"<tr><td><a href='s.txt'>"</script><td><a href="t&eacute;.txt"/>t
    <time datetime=2026-10-18T12:00:00Z>now</time></td></tr>
    <!-- <tr><td><a href="c.txt">c</a></td></tr> -->
    <tr><td><textarea><a href="ta.txt"></textarea><a>no link</a>
      <a href="d/">d</a><data>no value</data></td>
    </table><a href="out.txt">x</a><tr><td><a href="u.txt">u</a>`;
  assert.deepEqual(await read(html), [
    { Name: "r&s.txt", IsDir: false, Size: 12, MimeType: "", ModTime: "" },
    {
      Name: "té.txt",
      IsDir: false,
      Size: -1,
      MimeType: "",
      ModTime: "2026-10-18T12:00:00Z",
    },
    { Name: "d", IsDir: true, Size: -1, MimeType: "", ModTime: "" },
    { Name: "u.txt", IsDir: false, Size: -1, MimeType: "", ModTime: "" },
  ]);
});

test("renderListing keeps the digits of a time, as the precision of the remote", async () => {
  const entries = [
    "2026-10-18T15:02:41.540476887Z",
    "2026-10-18T15:02:41.540Z",
    "2026-10-18T22:02:41.540476+07:00",
  ].map((ModTime, index) => ({
    Name: `${index}.txt`,
    IsDir: false,
    Size: 1,
    MimeType: "text/plain",
    ModTime,
  }));
  const html = await new Response(renderListing(entries)).text();
  assert.deepEqual((await read(html)).map(({ ModTime }) => ModTime), [
    "2026-10-18T15:02:41.540476887Z",
    "2026-10-18T15:02:41.540Z",
    "2026-10-18T15:02:41.540476Z",
  ]);
});
