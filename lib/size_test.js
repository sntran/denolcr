import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSize } from "./size.js";

test("parseSize reads the sizes of rclone (TestSizeSuffixSet)", () => {
  for (
    const [text, size] of [
      ["0", 0],
      ["1b", 1],
      ["102B", 102],
      ["0.1k", 102],
      ["0.1", 102],
      ["1K", 1024],
      ["1k", 1024],
      ["1KI", 1024],
      ["1Ki", 1024],
      ["1kI", 1024],
      ["1ki", 1024],
      ["1KiB", 1024],
      ["1kib", 1024],
      ["1", 1024],
      ["2.5", 1024 * 2.5],
      ["1M", 1024 * 1024],
      ["1Mi", 1024 * 1024],
      ["1MiB", 1024 * 1024],
      ["1.g", 1024 * 1024 * 1024],
      ["10G", 10 * 1024 ** 3],
      ["10T", 10 * 1024 ** 4],
      ["10P", 10 * 1024 ** 5],
      ["off", -1],
      ["OFF", -1],
    ]
  ) {
    assert.equal(parseSize(text), size, text);
  }
  for (const text of ["", "1q", "1.q", "-1K", "1i", "1iB", "1MB"]) {
    assert.throws(() => parseSize(text), RangeError, text);
  }
});
