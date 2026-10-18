import { test } from "node:test";
import assert from "node:assert/strict";

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
