/**
 * The tests of crypt against rclone, in the two directions: rclone encrypts
 * and rfetch decrypts, then rfetch encrypts and rclone decrypts. The tests
 * run when rclone is in the PATH, or when RCLONE is the path of rclone.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import fc from "fast-check";

import { remote } from "@rfetch/lib/testing/remote";
// Sets the global `fetch` that reads the paths of remotes.
import "../../mod.js";
import crypt from "./main.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

// The password "123456" and the salt, obscured.
const PASSWORD = "UmyLSdRHfew6aual28-ggx78qHqSfQ";
const SALT = "Cj3gLa5PVwc2aot0QpKiOZ3YEzs3Sw";

/** The files: hard names, and sizes at the ends of the blocks of 64 KiB. */
const FILES = {
  "empty.txt": 0,
  "file name.txt": 1,
  "a/65535.bin": 65535,
  "a/65536.bin": 65536,
  "a/b/65537.bin": 65537,
  [`hello? sausage/êé/Hello, 世界/ " ' @ < > & ? + ≠/z.txt`]: 2 ** 20 + 1,
};

/** @param {number} size */
function content(size) {
  return new Uint8Array(size).map((_, index) => (index * 31 + size) & 0xff);
}

describe("crypt and rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-crypt-"));
  const config = join(folder, "rclone.conf");

  /** @param {string[]} args */
  function rclone(...args) {
    const { status, stdout, stderr } = spawnSync(
      RCLONE,
      ["--config", config, ...args],
      {
        env: { PATH: process.env.PATH, HOME: folder },
        maxBuffer: 64 * 2 ** 20,
      },
    );
    assert.equal(status, 0, `rclone ${args.join(" ")}: ${stderr}`);
    return stdout;
  }

  /**
   * A client of rfetch crypt on a folder of the local backend.
   * @param {string} name The folder, in the current folder.
   */
  const rfetch = (name) =>
    remote(crypt, {
      params: { remote: name, password: PASSWORD, password2: SALT },
    });

  before(() => {
    // The local backend serves the current folder.
    process.chdir(folder);
    writeFileSync(
      config,
      ["one", "two"].map((name) =>
        `[${name}]\ntype = crypt\nremote = ${join(folder, name)}\n` +
        `password = ${PASSWORD}\npassword2 = ${SALT}\n`
      ).join("\n"),
    );
    for (const [path, size] of Object.entries(FILES)) {
      mkdirSync(dirname(join(folder, "plain", path)), { recursive: true });
      writeFileSync(join(folder, "plain", path), content(size));
    }
  });
  after(() => rmSync(folder, { recursive: true, force: true }));

  test("rfetch reads what rclone encrypts", async () => {
    rclone("copy", join(folder, "plain"), "one:");
    const fs = rfetch("one");

    for (const [path, size] of Object.entries(FILES)) {
      const response = await fs.get(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("Content-Length"), `${size}`, path);
      assert.deepEqual(
        new Uint8Array(await response.arrayBuffer()),
        content(size),
        path,
      );
    }

    // The lists of rfetch have the names and sizes of `rclone lsjson`.
    const expected = JSON.parse(rclone("lsjson", "-R", "one:"));
    const actual = [];
    const walk = async (path) => {
      for (const entry of await fs.list(path)) {
        actual.push({
          Path: `${path}${entry.Name}`,
          IsDir: entry.IsDir,
          Size: entry.Size,
        });
        if (entry.IsDir) await walk(`${path}${entry.Name}/`);
      }
    };
    await walk("");
    // A folder has the size of the local folder in rclone, and no size in
    // rfetch.
    const sort = (entries) =>
      entries.map(({ Path, IsDir, Size }) =>
        IsDir ? { Path, IsDir } : { Path, IsDir, Size }
      )
        .sort((a, b) => a.Path < b.Path ? -1 : +(a.Path > b.Path));
    assert.deepEqual(sort(actual), sort(expected));
  });

  test("rclone reads what rfetch encrypts", async () => {
    const fs = rfetch("two");
    for (const [path, size] of Object.entries(FILES)) {
      const response = await fs.put(path, content(size), {
        "Content-Length": `${size}`,
      });
      assert.equal(response.status, 201, path);
    }

    rclone("copy", "two:", join(folder, "out"));
    for (const [path, size] of Object.entries(FILES)) {
      assert.deepEqual(
        new Uint8Array(readFileSync(join(folder, "out", path))),
        content(size),
        path,
      );
    }
    // rclone checks the files with the hashes of the data that it encrypts
    // again with the nonces of the files of rfetch.
    rclone("cryptcheck", join(folder, "plain"), "two:");
  });

  test("rclone and rfetch read the names and the data of each other", async () => {
    const name = fc.fullUnicodeString({ minLength: 1, maxLength: 40 })
      .filter((name) =>
        !/[/\0\n\r]/.test(name) && name.trim() === name && name !== "." &&
        name !== ".."
      );
    await fc.assert(
      fc.asyncProperty(
        name,
        fc.uint8Array({ maxLength: 3000 }),
        async (name, data) => {
          // rfetch encrypts, rclone decrypts.
          const fs = rfetch("two");
          await fs.put(`random/${name}`, data);
          assert.deepEqual(
            new Uint8Array(rclone("cat", `two:random/${name}`)),
            data,
          );
          // rclone encrypts, rfetch decrypts.
          writeFileSync(join(folder, "input"), data);
          rclone("copyto", join(folder, "input"), `one:random/${name}`);
          const response = await rfetch("one").get(`random/${name}`);
          assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data);

          await fs.delete("random/");
          await rfetch("one").delete("random/");
        },
      ),
      { numRuns: 20 },
    );
  });
});
