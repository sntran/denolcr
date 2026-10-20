import { test } from "node:test";
import assert from "node:assert/strict";

import { putFiles } from "../testing.js";
import { byteUnit, size } from "./main.js";

test("size gives the count and the size of the files, as rclone", async () => {
  await putFiles(":memory:/size/", {
    "f.txt": "hello",
    "a/g.txt": "world!",
    "a/b/zero": "",
  });
  assert.equal(
    await (await size(":memory:/size")).text(),
    "Total objects: 3\nTotal size: 11 B (11 Byte)\n",
  );
  assert.equal(
    await (await size(":memory:/size", { json: true })).text(),
    '{"count":3,"bytes":11,"sizeless":0}\n',
  );
  assert.equal(
    await (await size(":memory:/size/a/g.txt")).text(),
    "Total objects: 1\nTotal size: 6 B (6 Byte)\n",
  );
  assert.equal((await size(":memory:/size/missing")).status, 404);
});

test("byteUnit writes the sizes of rclone", () => {
  for (
    const [bytes, text] of [
      [0, "0 B"],
      [11, "11 B"],
      [1024, "1 KiB"],
      [1536, "1.500 KiB"],
      [5 * 1024 ** 3 + 1, "5.000 GiB"],
    ]
  ) {
    assert.equal(byteUnit(bytes), text, `${bytes}`);
  }
});
