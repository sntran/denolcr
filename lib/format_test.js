import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countString,
  formatBytes,
  formatDuration,
  sizeString,
} from "./format.js";

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

test("sizeString writes the sizes of rclone", () => {
  // The texts of SizeSuffix of rclone, from Go.
  for (
    const [size, text] of [
      [0, "0"],
      [1, "1"],
      [1023, "1023"],
      [1024, "1Ki"],
      [1025, "1.001Ki"],
      [1536, "1.500Ki"],
      // 120.5625: Go rounds a half to the even digit.
      [123456, "120.562Ki"],
      [1408, "1.375Ki"],
      [1048575, "1023.999Ki"],
      [1048576, "1Mi"],
      [5242881, "5.000Mi"],
      [67108864, "64Mi"],
      [1099511627776, "1Ti"],
      [1125899906842624, "1Pi"],
      [9007199254740991, "8.000Pi"],
    ]
  ) {
    assert.equal(sizeString(size, true), text, `${size}`);
    assert.equal(sizeString(size), `${size}`);
  }
  assert.equal(sizeString(-1, true), "-1");
  assert.equal(sizeString(-1), "-1");
});

test("countString writes the counts of rclone", () => {
  for (
    const [count, text] of [
      [0, "0"],
      [999, "999"],
      [1000, "1k"],
      [1001, "1.001k"],
      [1500, "1.500k"],
      [999999, "999.999k"],
      [1234567, "1.235M"],
      [1000000, "1M"],
    ]
  ) {
    assert.equal(countString(count, true), text, `${count}`);
  }
  assert.equal(countString(-1, true), "-1");
  assert.equal(countString(-1), "-1");
});
