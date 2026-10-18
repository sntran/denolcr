import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { childOf, readListing, renderListing } from "./listing.js";
import { HTMLRewriter } from "@sntran/html-rewriter";

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
 * The entries of a list, with HTMLRewriter and the selectors that
 * readListing follows: the reference for the tests.
 * @param {string} html
 */
async function readWithRewriter(html) {
  const entries = [];
  let entry = null;
  await new HTMLRewriter()
    .on("tr", {
      element() {
        entry = null;
      },
    })
    .on("tr a[href]", {
      element(element) {
        const name = childOf(element.getAttribute("href"), base);
        if (name === null) return;
        const isDir = name.endsWith("/");
        const link = {
          Name: isDir ? name.slice(0, -1) : name,
          IsDir: isDir,
          Size: -1,
          MimeType: element.getAttribute("type") || "",
          ModTime: "",
        };
        if (entry) entries[entries.length - 1] = link;
        else entries.push(link);
        entry = link;
      },
    })
    .on("tr data[value]", {
      element(element) {
        if (entry) entry.Size = Number(element.getAttribute("value"));
      },
    })
    .on("tr time[datetime]", {
      element(element) {
        if (entry) entry.ModTime = element.getAttribute("datetime");
      },
    })
    .transform(new Response(html))
    .arrayBuffer();
  return entries;
}

test("readListing gives the entries of HTMLRewriter", async (t) => {
  await t.test("for each list of renderListing", async () => {
    const entry = fc.record({
      Name: fc.fullUnicodeString({ minLength: 1, maxLength: 12 }),
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
        async (entries, query) => {
          const html = await new Response(renderListing(entries, { query }))
            .text();
          assert.deepEqual(await read(html), await readWithRewriter(html));
        },
      ),
      { numRuns: 50 },
    );
  });

  await t.test("for HTML that is not of renderListing", async () => {
    const html = `<TABLE><tr><td><A HREF='q.txt' type=text/plain TYPE="x">q</A>
      <a href=r.txt>r</a></td><td><DATA value=" 12 ">12</DATA></td></tr>
      <tr><script>"<tr><td><a href='s.txt'>"</script><td><a href="t.txt"/>t
      <time datetime=2026-10-18T12:00:00Z>now</time></td></tr>
      <!-- <tr><td><a href="c.txt">c</a></td></tr> -->
      <tr><td><a>no link</a><a href="d/">d</a><data>no value</data></td>
      </table><a href="out.txt">x</a><tr><td><a href="u.txt">u</a>`;
    const entries = await read(html);
    assert.deepEqual(entries.map(({ Name }) => Name), [
      "r.txt",
      "t.txt",
      "d",
      "u.txt",
    ]);
    assert.deepEqual(entries, await readWithRewriter(html));
  });
});
