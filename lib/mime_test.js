import { test } from "node:test";
import assert from "node:assert/strict";

import { mimeType } from "./mime.js";

test("mimeType", () => {
  // The table of Go, the additions of rclone, and .txt.
  assert.equal(mimeType("index.html"), "text/html; charset=utf-8");
  assert.equal(mimeType("photo.JPG"), "image/jpeg");
  assert.equal(mimeType("a/b.c/song.mp3"), "audio/mpeg");
  assert.equal(mimeType("movie.mkv"), "video/x-matroska");
  assert.equal(mimeType("hello.txt"), "text/plain; charset=utf-8");
  // An unknown extension, no extension, and a dot in a folder only.
  for (
    const name of ["1MB.bin", "README", "a.b/c", "toString", ".constructor"]
  ) {
    assert.equal(mimeType(name), "application/octet-stream", name);
  }
});
