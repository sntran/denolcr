/**
 * The tests of lsjson against rclone lsjson, on the same local folder. The
 * tests run when rclone is in the PATH, or when RCLONE is the path of rclone.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { lsjson } from "./main.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

/** The files, with names that have "?", "#", "%", spaces and Unicode. */
const FILES = [
  "a?b/c#d/e%f.txt",
  "a?b/g h.json",
  "i%20j/k?.html",
  "l#/m",
  "n o/ê é/Hello, 世界.bin",
  "p.txt",
];

describe("lsjson and rclone lsjson", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-lsjson-"));
  const cwd = process.cwd();

  before(() => {
    for (const [index, path] of FILES.entries()) {
      mkdirSync(dirname(join(folder, "tree", path)), { recursive: true });
      writeFileSync(join(folder, "tree", path), "x".repeat(index * 10));
    }
    // The local backend serves the current folder.
    process.chdir(folder);
  });
  after(() => {
    process.chdir(cwd);
    rmSync(folder, { recursive: true, force: true });
  });

  /** The fields to compare, in the order of the paths. */
  function normalize(entries) {
    return entries
      .map(({ Path, Name, Size, IsDir, MimeType, ModTime }) => ({
        Path,
        Name,
        // rclone gives the size of a local folder on the disk.
        Size: IsDir ? -1 : Size,
        IsDir,
        MimeType,
        // rclone has nanoseconds, and the lists of rfetch milliseconds.
        ModTime: IsDir ? 0 : Math.floor(Date.parse(ModTime)),
      }))
      .sort((a, b) => a.Path < b.Path ? -1 : +(a.Path > b.Path));
  }

  test("lsjson --recursive gives the entries of rclone lsjson -R", async () => {
    const { status, stdout, stderr } = spawnSync(
      RCLONE,
      ["lsjson", "-R", join(folder, "tree")],
      { env: { PATH: process.env.PATH, HOME: folder } },
    );
    assert.equal(status, 0, `${stderr}`);
    const actual = await lsjson("/tree/", { recursive: "true" })
      .then((response) => response.json());
    assert.deepEqual(normalize(actual), normalize(JSON.parse(stdout)));
  });
});
