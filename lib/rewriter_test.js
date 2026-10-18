import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { attributeOf, readElements } from "./rewriter.js";
import { escapeHTML } from "./html.js";

/**
 * The elements of a document, as `name href` lines, for the selector.
 * @param {Response} response
 * @param {string} selector
 */
async function linesOf(response, selector) {
  const lines = [];
  await readElements(response, [
    [selector, {
      element(element) {
        lines.push(`${element.tagName} ${attributeOf(element, "href")}`);
      },
    }],
  ]);
  return lines;
}

test("readElements reads HTML as the HTML standard tells", async () => {
  const html = `<!DOCTYPE html><title><a href="title"></title>
    <A HREF=one>1</A><a href='two'>2</a>
    <script>document.write('<a href="script">')</script>
    <!-- <a href="comment"> --><textarea><a href="textarea"></textarea>
    <style>a { content: '<a href="style">' }</style>
    <a href="three" href="not">3</a><a>no link</a>`;
  assert.deepEqual(await linesOf(new Response(html), "a[href]"), [
    "a one",
    "a two",
    "a three",
  ]);
});

test("readElements gives the same elements for each cut in chunks", async () => {
  const html = `<table><tr><td><a href="a%20b.txt">é</a></td></tr>
    <tr><td><a href="c&amp;d/">c</a></td></tr></table>`;
  const bytes = new TextEncoder().encode(html);
  const expected = await linesOf(new Response(html), "tr a[href]");
  assert.deepEqual(expected, ["a a%20b.txt", "a c&d/"]);
  await fc.assert(
    fc.asyncProperty(fc.array(fc.nat(bytes.length)), async (cuts) => {
      const places = [...new Set([0, ...cuts, bytes.length])]
        .sort((a, b) => a - b);
      const chunks = places.slice(1).map((end, index) =>
        bytes.subarray(places[index], end)
      );
      const response = new Response(new Blob(chunks).stream());
      assert.deepEqual(await linesOf(response, "tr a[href]"), expected);
    }),
    { numRuns: 50 },
  );
});

test("readElements reads no element of a response with no body", async () => {
  const response = new Response(null);
  assert.deepEqual(await linesOf(response, "a[href]"), []);
});

test("readElements gives the error of a handler", async () => {
  await assert.rejects(
    readElements(new Response("<a href=x>x</a>"), [
      ["a", {
        element() {
          throw new Error("no");
        },
      }],
    ]),
  );
});

test("attributeOf", async (t) => {
  /** The attribute `href` of the first link of the HTML. */
  const hrefOf = async (html) => {
    let href;
    await readElements(new Response(html), [
      ["a", {
        element(element) {
          href ??= attributeOf(element, "href");
        },
      }],
    ]);
    return href;
  };

  await t.test("decodes the character references", async () => {
    assert.equal(
      await hrefOf(`<a href="a&amp;b&lt;c&#x20;d&#39;&eacute;&nbsp;">x</a>`),
      "a&b<c d'é\u00a0",
    );
  });

  await t.test("keeps a legacy reference before = as text", async () => {
    assert.equal(
      await hrefOf(`<a href="?a=1&copy=2&amp">x</a>`),
      "?a=1&copy=2&",
    );
  });

  await t.test("gives null for no attribute", async () => {
    assert.equal(await hrefOf(`<a>x</a>`), null);
  });

  await t.test("is the inverse of escapeHTML", async () => {
    await fc.assert(
      fc.asyncProperty(fc.fullUnicodeString(), async (text) => {
        assert.equal(await hrefOf(`<a href="${escapeHTML(text)}">`), text);
      }),
      { numRuns: 50 },
    );
  });
});
