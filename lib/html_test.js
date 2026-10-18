import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { decodeAttribute, escapeHTML, scanTags } from "./html.js";

test("escapeHTML", async (t) => {
  await t.test("puts a reference for each character of HTML", () => {
    assert.equal(
      escapeHTML(`<a href="x">Tom & Jerry's</a>`),
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });

  await t.test("does not change other text", () => {
    assert.equal(escapeHTML("Hello, 世界 ≠ ?+#"), "Hello, 世界 ≠ ?+#");
  });
});

test("decodeAttribute", async (t) => {
  await t.test("decodes the basic and the numeric references", () => {
    assert.equal(
      decodeAttribute("a&amp;b&lt;c&gt;d&quot;e&apos;f&#39;g&#x27;h&#X1F600;"),
      "a&b<c>d\"e'f'g'h😀",
    );
  });

  await t.test("keeps other references and the legacy cases as text", () => {
    assert.equal(decodeAttribute("&eacute;&nbsp;"), "&eacute;&nbsp;");
    assert.equal(decodeAttribute("?a=1&ampb=2"), "?a=1&ampb=2");
    assert.equal(decodeAttribute("&amp=x"), "&amp=x");
    assert.equal(decodeAttribute("&amp &lt"), "& <");
    assert.equal(decodeAttribute("&apos"), "&apos");
    assert.equal(decodeAttribute("&#0;&#xD800;&#x110000;"), "�".repeat(3));
  });

  await t.test("is the inverse of escapeHTML", () => {
    fc.assert(
      fc.property(fc.fullUnicodeString(), (text) => {
        assert.equal(decodeAttribute(escapeHTML(text)), text);
      }),
    );
  });
});

/** The tags of a document, as lines: `+name attributes` and `-name`. */
function tagsOf(html) {
  const lines = [];
  scanTags(html, {
    start(name, attributes) {
      lines.push(`+${name}${JSON.stringify([...attributes])}`);
    },
    end(name) {
      lines.push(`-${name}`);
    },
  });
  return lines;
}

test("scanTags", async (t) => {
  await t.test("reads the names and the attributes of tags", () => {
    assert.deepEqual(
      tagsOf(`<A HREF='a > b' Type=text/plain data-x="1" data-x="2" checked
        title="&quot;x&quot;"/>t</A>`),
      [
        `+a[["href","a > b"],["type","text/plain"],["data-x","1"],["checked",""],["title","\\"x\\""]]`,
        "-a",
      ],
    );
  });

  await t.test("does not read the tags in comments and in the text of script", () => {
    assert.deepEqual(
      tagsOf(`<!-- <a href="1"> --><!--><!---><!DOCTYPE html><?x <b>?>
        <script>"<a href='2'></script >"</script><style><a></STYLE>
        <title><a></title><textarea></textarea x><a href="3">`),
      [
        "+script[]",
        "-script",
        "+style[]",
        "-style",
        "+title[]",
        "-title",
        "+textarea[]",
        "-textarea",
        `+a[["href","3"]]`,
      ],
    );
  });

  await t.test("ends the open elements in an element at its end tag", () => {
    assert.deepEqual(
      tagsOf("<table><tr><td><br><img src=x></table></tr></p><p a<b>"),
      [
        "+table[]",
        "+tr[]",
        "+td[]",
        "+br[]",
        `+img[["src","x"]]`,
        "-td",
        "-tr",
        "-table",
        `+p[["a<b",""]]`,
      ],
    );
  });

  await t.test("is not a tag: text with <, and a tag at the end of the document", () => {
    assert.deepEqual(tagsOf("a < b <3 </ > </1> <a href='x"), []);
    assert.deepEqual(tagsOf("<plaintext><a href=x>"), ["+plaintext[]"]);
  });

  await t.test("reads any document with no error", () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ maxLength: 200 }), (html) => {
        tagsOf(html);
      }),
    );
  });
});
