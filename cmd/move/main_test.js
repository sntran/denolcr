import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { fetch } from "../../fetch.js";
import { contents, putFiles } from "../testing.js";
import { move, moveto } from "./main.js";

const SOURCE = ":memory:/move/source/";
const TARGET = ":memory:/move/target/";

describe("move and moveto", () => {
  beforeEach(async () => {
    await (await fetch(":memory:/move/", { method: "DELETE" })).body?.cancel();
    await putFiles(SOURCE, { "f.txt": "hello", "a/g.txt": "world!" });
  });

  test("move copies the files, and deletes them in the source", async () => {
    assert.equal((await move(SOURCE, TARGET)).status, 200);
    assert.deepEqual((await contents(TARGET)).files, {
      "f.txt": "hello",
      "a/g.txt": "world!",
    });
    // The folders of the source stay, as rclone.
    assert.deepEqual(await contents(SOURCE), { files: {}, folders: ["a"] });
  });

  test("move --delete-empty-src-dirs deletes the folders too", async () => {
    await move(SOURCE, TARGET, { delete_empty_src_dirs: true });
    assert.deepEqual(await contents(SOURCE), { files: {}, folders: [] });
  });

  test("moveto renames a file", async () => {
    assert.equal(
      (await moveto(`${SOURCE}f.txt`, `${SOURCE}renamed.txt`)).status,
      200,
    );
    assert.deepEqual((await contents(SOURCE)).files, {
      "renamed.txt": "hello",
      "a/g.txt": "world!",
    });
  });
});
