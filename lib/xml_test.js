import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { childrenOf, escapeXML, isXMLText, parseXML, textOf } from "./xml.js";

test("parseXML reads an answer of S3", () => {
  const root = parseXML(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>a &amp; b &lt;c&gt; &#233;&#x4E16;</Key><Size>10</Size></Contents>
  <Contents><Key><![CDATA[<raw>]]></Key><Size>0</Size></Contents>
  <CommonPrefixes><Prefix>d/</Prefix></CommonPrefixes>
  <!-- a comment -->
  <Empty/>
</ListBucketResult>`);
  assert.equal(root.name, "ListBucketResult");
  assert.equal(textOf(root, "Name"), "bucket");
  assert.deepEqual(
    childrenOf(root, "Contents").map((
      c,
    ) => [textOf(c, "Key"), textOf(c, "Size")]),
    [["a & b <c> é世", "10"], ["<raw>", "0"]],
  );
  assert.equal(textOf(childrenOf(root, "CommonPrefixes")[0], "Prefix"), "d/");
  assert.equal(childrenOf(root, "Empty").length, 1);
  assert.equal(textOf(root, "Missing"), "");
});

test("parseXML reads the names with a namespace prefix", () => {
  const root = parseXML("<s3:Error><s3:Code>NoSuchKey</s3:Code></s3:Error>");
  assert.equal(root.name, "Error");
  assert.equal(textOf(root, "Code"), "NoSuchKey");
});

test("parseXML refuses elements that do not close in order", () => {
  for (const text of ["<a><b></a>", "<a>", "</a>", "<a/><b/>", "text"]) {
    assert.throws(() => parseXML(text), SyntaxError, text);
  }
});

test("parseXML reads the text that escapeXML writes", () => {
  fc.assert(
    fc.property(fc.string(), (text) => {
      // XML 1.0 has no control characters other than tab and line breaks.
      fc.pre(isXMLText(text));
      assert.equal(parseXML(`<a>${escapeXML(text)}</a>`).text, text);
    }),
  );
});

test("isXMLText refuses the characters that XML 1.0 cannot have", () => {
  for (const text of ["a", "\t\n\r", "é世😀"]) assert.ok(isXMLText(text), text);
  for (const text of ["\0", "\v", "\x1f", "\ud800", "a\udc00", "\uffff"]) {
    assert.ok(!isXMLText(text), JSON.stringify(text));
  }
});
