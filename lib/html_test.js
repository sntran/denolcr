import { test } from "node:test";
import assert from "node:assert/strict";

import { escapeHTML } from "./html.js";

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
