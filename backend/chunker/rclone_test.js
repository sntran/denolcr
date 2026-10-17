/**
 * The tests of chunker against rclone, in the two directions, with the
 * modes of rclone: the metadata `simplejson` or `none`, and the
 * transactions `rename` or `norename`. The tests run when rclone is in the
 * PATH, or when RCLONE is the path of rclone.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { remote } from "../../lib/testing/remote.js";
// Sets the global `fetch` that reads the paths of remotes.
import "../../mod.js";
import chunker from "./main.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

/** The files: sizes at the ends of the chunks of 1 KiB, and hard names. */
const FILES = {
  "empty.bin": 0,
  "one.bin": 1,
  "a/1023.bin": 1023,
  "a/1024.bin": 1024,
  "a/b/1025.bin": 1025,
  "file name #1.txt": 2048,
  [`hello? sausage/êé/Hello, 世界/ " ' @ < > & ? + ≠/z.txt`]: 3000,
};

/** The modes, with their options. */
const MODES = {
  rename: { chunk_size: "1k" },
  none: { chunk_size: "1k", meta_format: "none", hash_type: "none" },
  norename: { chunk_size: "1k", transactions: "norename" },
};

/** @param {number} size */
function content(size) {
  return new Uint8Array(size).map((_, index) => (index * 13 + size) & 0xff);
}

/**
 * The files in a folder and in its folders, with their paths.
 * @param {string} folder
 * @returns {string[]}
 */
function tree(folder) {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath ?? entry.path, entry.name).slice(folder.length + 1)
    )
    .sort();
}

describe("chunker and rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-chunker-"));
  const config = join(folder, "rclone.conf");

  /** @param {string[]} args */
  function rclone(...args) {
    const { status, stdout, stderr } = spawnSync(
      RCLONE,
      ["--config", config, ...args],
      { env: { PATH: process.env.PATH, HOME: folder } },
    );
    assert.equal(status, 0, `rclone ${args.join(" ")}: ${stderr}`);
    return stdout;
  }

  before(() => {
    // The local backend serves the current folder.
    process.chdir(folder);
    const sections = [];
    for (const [mode, options] of Object.entries(MODES)) {
      for (const side of ["by-rclone", "by-rfetch"]) {
        const lines = Object.entries(options).map(([key, value]) =>
          `${key} = ${value}`
        );
        sections.push(
          `[${mode}-${side}]\ntype = chunker\n` +
            `remote = ${join(folder, mode, side)}\n${lines.join("\n")}\n`,
        );
      }
    }
    writeFileSync(config, sections.join("\n"));
    for (const [path, size] of Object.entries(FILES)) {
      mkdirSync(dirname(join(folder, "plain", path)), { recursive: true });
      writeFileSync(join(folder, "plain", path), content(size));
    }
  });
  after(() => rmSync(folder, { recursive: true, force: true }));

  for (const [mode, options] of Object.entries(MODES)) {
    const rfetch = (side) =>
      remote(chunker, {
        params: { remote: `${mode}/${side}`, ...options },
      });

    test(`${mode}: rfetch reads what rclone writes`, async () => {
      rclone("copy", join(folder, "plain"), `${mode}-by-rclone:`);
      const fs = rfetch("by-rclone");
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

      // The lists have the names and sizes of `rclone lsjson -R`.
      const expected = JSON.parse(
        rclone("lsjson", "-R", "--files-only", `${mode}-by-rclone:`),
      )
        .map(({ Path, Size }) => ({ Path, Size }));
      const actual = [];
      const walk = async (path) => {
        for (const entry of await fs.list(path)) {
          if (entry.IsDir) await walk(`${path}${entry.Name}/`);
          else actual.push({ Path: `${path}${entry.Name}`, Size: entry.Size });
        }
      };
      await walk("");
      const sort = (entries) =>
        entries.sort((a, b) => a.Path < b.Path ? -1 : +(a.Path > b.Path));
      assert.deepEqual(sort(actual), sort(expected));
    });

    test(`${mode}: rclone reads what rfetch writes`, async () => {
      const fs = rfetch("by-rfetch");
      for (const [path, size] of Object.entries(FILES)) {
        const response = await fs.put(path, content(size));
        assert.equal(response.status, 201, path);
      }
      // rclone checks the files, with the hashes of the metadata.
      rclone("check", join(folder, "plain"), `${mode}-by-rfetch:`);
      rclone("copy", `${mode}-by-rfetch:`, join(folder, "out", mode));
      for (const [path, size] of Object.entries(FILES)) {
        assert.deepEqual(
          new Uint8Array(readFileSync(join(folder, "out", mode, path))),
          content(size),
          path,
        );
      }
    });

    test(`${mode}: rclone and rfetch write the same files`, () => {
      const byRclone = join(folder, mode, "by-rclone");
      const byRfetch = join(folder, mode, "by-rfetch");
      // A transaction has a random suffix of 6 characters.
      const names = (side) =>
        tree(side).map((name) => name.replace(/_[0-9a-z]{4,9}$/, "_XACT"));
      assert.deepEqual(names(byRfetch), names(byRclone));
      if (mode === "rename") {
        // The same chunks and the same metadata, byte for byte.
        for (const name of tree(byRclone)) {
          assert.deepEqual(
            readFileSync(join(byRfetch, name)),
            readFileSync(join(byRclone, name)),
            name,
          );
        }
      }
    });
  }

  test("rclone reads a file that rfetch writes with no Content-Length", async () => {
    const fs = remote(chunker, {
      params: { remote: "rename/by-rfetch", ...MODES.rename },
    });
    for (const size of [10, 3000]) {
      const response = await fs.send(`stream-${size}.bin`, {
        method: "PUT",
        body: new Blob([content(size)]).stream(),
        duplex: "half",
      });
      assert.equal(response.status, 201);
      assert.deepEqual(
        new Uint8Array(rclone("cat", `rename-by-rfetch:stream-${size}.bin`)),
        content(size),
      );
    }
  });
});
