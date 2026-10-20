import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { fetch } from "../../fetch.js";
import { captureLog, contents, putFiles } from "../testing.js";
import { copy, copyto } from "./main.js";

const SOURCE = ":memory:/copy/source/";
const TARGET = ":memory:/copy/target/";

describe("copy and copyto", () => {
  beforeEach(async () => {
    await (await fetch(":memory:/copy/", { method: "DELETE" })).body?.cancel();
    await putFiles(SOURCE, {
      "f.txt": "hello",
      "a/g.txt": "world!",
      "a/b/zero": "",
      "n?m/#1.txt": "name",
    });
    await (await fetch(`${SOURCE}empty/`, { method: "PUT" })).body?.cancel();
  });

  test("copy puts the contents of a folder in the target", async () => {
    assert.equal((await copy(SOURCE, TARGET)).status, 200);
    assert.deepEqual(await contents(TARGET), {
      files: {
        "f.txt": "hello",
        "a/g.txt": "world!",
        "a/b/zero": "",
        "n?m/#1.txt": "name",
      },
      folders: ["a", "a/b", "n?m"],
    });
  });

  test("copy --create-empty-src-dirs makes the empty folders too", async () => {
    await copy(SOURCE, TARGET, { create_empty_src_dirs: true });
    assert.ok((await contents(TARGET)).folders.includes("empty"));
  });

  test("copy of a file puts it in the target folder", async () => {
    assert.equal((await copy(`${SOURCE}a/g.txt`, TARGET)).status, 200);
    assert.deepEqual((await contents(TARGET)).files, { "g.txt": "world!" });
  });

  test("copyto gives the file the name of the target", async () => {
    assert.equal(
      (await copyto(`${SOURCE}a/g.txt`, `${TARGET}x/new.txt`)).status,
      200,
    );
    assert.deepEqual((await contents(TARGET)).files, { "x/new.txt": "world!" });
    const self = await copyto(`${SOURCE}f.txt`, `${SOURCE}f.txt`);
    assert.equal(self.status, 400);
  });

  test("copy skips the same files, as rclone", async () => {
    await putFiles(TARGET, { "f.txt": "HELLO", "a/g.txt": "other!!" });
    // Same size: with --size-only, the file is the same.
    await copy(SOURCE, TARGET, { size_only: true });
    let files = (await contents(TARGET)).files;
    assert.equal(files["f.txt"], "HELLO");
    assert.equal(files["a/g.txt"], "world!");

    // The times differ: the file goes again.
    await copy(SOURCE, TARGET);
    files = (await contents(TARGET)).files;
    assert.equal(files["f.txt"], "hello");

    await putFiles(TARGET, { "f.txt": "HELLO" });
    await copy(SOURCE, TARGET, { ignore_existing: true });
    assert.equal((await contents(TARGET)).files["f.txt"], "HELLO");
  });

  test("copy --dry-run copies nothing", async (t) => {
    const lines = captureLog(t);
    assert.equal((await copy(SOURCE, TARGET, { dry_run: true })).status, 200);
    assert.equal(await contents(TARGET), null);
    assert.ok(
      lines.includes(
        "NOTICE: f.txt: Skipped copy as --dry-run is set (size 5)",
      ),
      lines.join("\n"),
    );
  });

  test("copy of a source that does not exist gives 404", async () => {
    assert.equal((await copy(`${SOURCE}missing`, TARGET)).status, 404);
  });
});
