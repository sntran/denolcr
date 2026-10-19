import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { fetch } from "../../fetch.js";
import { captureLog, contents, putFiles } from "../testing.js";
import { delete as remove, deletefile, purge, rmdir, rmdirs } from "./main.js";

const ROOT = ":memory:/delete/";

describe("the commands that delete", () => {
  beforeEach(async () => {
    await (await fetch(ROOT, { method: "DELETE" })).body?.cancel();
    await putFiles(ROOT, {
      "f.txt": "hello",
      "a/g.txt": "world!",
      "a/b/zero": "",
      "a?b/#c.txt": "x",
    });
    await (await fetch(`${ROOT}empty/inner/`, { method: "PUT" })).body
      ?.cancel();
  });

  test("delete removes the files, and keeps the folders", async () => {
    assert.equal((await remove(ROOT)).status, 200);
    assert.deepEqual(await contents(ROOT), {
      files: {},
      folders: ["a", "a/b", "a?b", "empty", "empty/inner"],
    });
  });

  test("delete --rmdirs removes the folders too, but not the root", async () => {
    assert.equal((await remove(ROOT, { rmdirs: true })).status, 200);
    assert.deepEqual(await contents(ROOT), { files: {}, folders: [] });
  });

  test("delete of a file removes only that file", async () => {
    assert.equal((await remove(`${ROOT}a/g.txt`)).status, 200);
    assert.deepEqual(Object.keys((await contents(ROOT)).files).sort(), [
      "a/b/zero",
      "a?b/#c.txt",
      "f.txt",
    ]);
  });

  test("delete --dry-run removes nothing, and tells what", async (t) => {
    const lines = captureLog(t);
    assert.equal((await remove(ROOT, { dry_run: true })).status, 200);
    assert.equal(Object.keys((await contents(ROOT)).files).length, 4);
    assert.ok(
      lines.includes(
        "NOTICE: f.txt: Skipped delete as --dry-run is set (size 5)",
      ),
      lines.join("\n"),
    );
  });

  test("deletefile removes a file, and refuses a folder", async () => {
    assert.equal((await deletefile(`${ROOT}f.txt`)).status, 200);
    for (const path of ["a", "missing.txt"]) {
      const response = await deletefile(`${ROOT}${path}`);
      assert.equal(response.status, 404);
      assert.match(await response.text(), /object not found$/);
    }
  });

  test("purge removes a folder and all in it", async () => {
    assert.equal((await purge(`${ROOT}a`)).status, 200);
    assert.deepEqual((await contents(ROOT)).folders, [
      "a?b",
      "empty",
      "empty/inner",
    ]);
    assert.equal((await purge(`${ROOT}f.txt`)).status, 400);
    assert.equal((await purge(`${ROOT}missing`)).status, 404);
  });

  test("rmdir removes only an empty folder", async () => {
    const full = await rmdir(`${ROOT}a`);
    assert.equal(full.status, 409);
    assert.match(await full.text(), /directory not empty/);
    assert.equal((await rmdir(`${ROOT}empty/inner`)).status, 200);
    assert.equal((await rmdir(`${ROOT}missing`)).status, 404);
    assert.deepEqual((await contents(ROOT)).folders, [
      "a",
      "a/b",
      "a?b",
      "empty",
    ]);
  });

  test("rmdirs removes the folders with no file", async () => {
    await (await fetch(`${ROOT}a/b/c/`, { method: "PUT" })).body?.cancel();
    assert.equal((await rmdirs(ROOT)).status, 200);
    assert.deepEqual((await contents(ROOT)).folders, ["a", "a/b", "a?b"]);

    // The root goes when it has no file, unless --leave-root.
    await (await fetch(ROOT, { method: "DELETE" })).body?.cancel();
    await (await fetch(`${ROOT}x/y/`, { method: "PUT" })).body?.cancel();
    assert.equal((await rmdirs(ROOT, { leave_root: true })).status, 200);
    assert.deepEqual(await contents(ROOT), { files: {}, folders: [] });
    assert.equal((await rmdirs(ROOT)).status, 200);
    assert.equal(await contents(ROOT), null);
  });
});
