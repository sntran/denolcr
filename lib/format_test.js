import { test } from "node:test";
import assert from "node:assert/strict";

import { formatBytes, formatDuration } from "./format.js";

// The texts of `format` of @std/fmt 0.225, which these functions replace.
test("formatBytes", () => {
  const cases = [
    [0, {}, "0 B"],
    [0.5, {}, "0.5 B"],
    [999, {}, "999 B"],
    [1000, {}, "1 kB"],
    [1536, {}, "1.54 kB"],
    [1536, { binary: true }, "1.5 KiB"],
    [1048576, { binary: true }, "1 MiB"],
    [123456789, {}, "123 MB"],
    [2 ** 40, { binary: true }, "1 TiB"],
    [1e30, {}, "1000000 YB"],
    [-1536, { binary: true }, "-1.5 KiB"],
    [1234567, { locale: true }, `${(1.23).toLocaleString()} MB`],
  ];
  for (const [bytes, options, text] of cases) {
    assert.equal(formatBytes(bytes, options), text, `${bytes}`);
  }
  assert.throws(() => formatBytes(Infinity), TypeError);
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "");
  assert.equal(formatDuration(61000), "1m 1s");
  assert.equal(formatDuration(90061001.5), "1d 1h 1m 1s 1ms 500µs");
  assert.equal(formatDuration(0.000001), "1ns");
  assert.equal(formatDuration(-3600000), "1h");
});
