/**
 * The tests of the lists of text against the lists of rclone, on the same
 * local folder: ls, lsl, lsd and lsf. The tests run when rclone is in the
 * PATH, or when RCLONE is the path of rclone.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { ls } from "../ls/main.js";
import { lsd } from "../lsd/main.js";
import { lsl } from "../lsl/main.js";
import { lsf } from "./main.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

/** The files, with names that CSV puts in quotes, and their sizes. */
const FILES = {
  "a,b.txt": 1,
  'q"t.txt': 1024,
  " space.txt": 1536,
  "semi;colon/big.bin": 123456,
  "n o/ê é/Hello, 世界.bin": 5,
};

describe("the lists of text and the lists of rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-lsf-"));
  const cwd = process.cwd();

  before(() => {
    for (const [path, size] of Object.entries(FILES)) {
      mkdirSync(dirname(join(folder, "tree", path)), { recursive: true });
      writeFileSync(join(folder, "tree", path), new Uint8Array(size));
    }
    // The local backend serves the current folder.
    process.chdir(folder);
  });
  after(() => {
    process.chdir(cwd);
    rmSync(folder, { recursive: true, force: true });
  });

  /**
   * The lines of rclone, in order: rclone lists the folders at the same
   * time, thus its order can change.
   * @param {string[]} args
   */
  function rclone(args) {
    const { status, stdout, stderr } = spawnSync(RCLONE, args, {
      cwd: folder,
      env: {
        PATH: process.env.PATH,
        HOME: folder,
        // The same time zone as the test.
        ...process.env.TZ ? { TZ: process.env.TZ } : {},
      },
    });
    assert.equal(status, 0, `${stderr}`);
    return `${stdout}`.split("\n").slice(0, -1).sort();
  }

  /** @param {Promise<Response>} response */
  async function lines(response) {
    const text = await (await response).text();
    return text.split("\n").slice(0, -1).sort();
  }

  test("ls", async () => {
    assert.deepEqual(await lines(ls("tree/")), rclone(["ls", "tree"]));
    assert.deepEqual(
      await lines(ls("tree/", { human_readable: true })),
      rclone(["ls", "--human-readable", "tree"]),
    );
  });

  test("lsl", async () => {
    assert.deepEqual(await lines(lsl("tree/")), rclone(["lsl", "tree"]));
  });

  test("lsd", async () => {
    // rclone gives the size of a local folder on the disk, and rfetch -1,
    // as the other backends: the lines are the same after the size.
    const cut = (list, width) => list.map((line) => line.slice(width)).sort();
    assert.deepEqual(
      cut(await lines(lsd("tree/", { recursive: true })), 12),
      cut(rclone(["lsd", "-R", "tree"]), 12),
    );
    assert.deepEqual(
      cut(await lines(lsd("tree/", { human_readable: true })), 9),
      cut(rclone(["lsd", "--human-readable", "tree"]), 9),
    );
  });

  test("lsf", async () => {
    for (
      const [flags, args] of [
        [{ recursive: true }, ["-R"]],
        [{ recursive: true, format: "pst", files_only: true }, [
          "-R",
          "--format",
          "pst",
          "--files-only",
        ]],
        [{ recursive: true, csv: true, format: "ps", files_only: true }, [
          "-R",
          "--csv",
          "--format",
          "ps",
          "--files-only",
        ]],
        [{ csv: true, separator: ";", format: "sp" }, [
          "--csv",
          "--separator",
          ";",
          "--format",
          "sp",
        ]],
        [{ dirs_only: true, dir_slash: false }, [
          "--dirs-only",
          "--dir-slash=false",
        ]],
      ]
    ) {
      assert.deepEqual(
        await lines(lsf("tree/", flags)),
        rclone(["lsf", ...args, "tree"]),
        args.join(" "),
      );
    }
  });
});
