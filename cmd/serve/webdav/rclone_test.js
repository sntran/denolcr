/**
 * The tests of `rfetch serve webdav` with rclone as the client: the webdav
 * backend of rclone writes, reads, copies, moves and deletes the files of a
 * local folder through the server. The tests run when rclone is in the
 * PATH, or when RCLONE is the path of rclone.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

import { serve } from "../main.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

/** The files, with hard names, and their sizes. */
const FILES = {
  "empty.txt": 0,
  "a/one.bin": 1,
  "a/b/c.json": 100,
  "file name #1.txt": 2048,
  [`hello? sausage/êé/Hello, 世界/ " ' @ < > & + ≠/z.txt`]: 3000,
  "big.bin": 3 * 1024 * 1024 + 7,
};

/** @param {number} size */
function content(size) {
  return new Uint8Array(size).map((_, index) => (index * 13 + size) & 0xff);
}

describe("serve webdav and rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  /** The folders of the test: the source, and the folder of the server. */
  let home;
  let source;
  let served;
  let reader;
  /** The remote of rclone for the server. */
  let target;

  /**
   * Runs rclone, and gives the bytes of its output.
   * @param {...string} args
   * @returns {Promise<Buffer>}
   */
  const rclone = (...args) =>
    new Promise((resolve, reject) => {
      // rclone runs in another process: the server of this process must
      // answer it while it runs.
      const child = spawn(RCLONE, args, {
        env: { PATH: process.env.PATH, HOME: home },
      });
      const out = [];
      const err = [];
      child.stdout.on("data", (chunk) => out.push(chunk));
      child.stderr.on("data", (chunk) => err.push(chunk));
      child.on("error", reject);
      child.on("close", (status) => {
        if (status === 0) resolve(Buffer.concat(out));
        else reject(new Error(`rclone ${args[0]}: ${Buffer.concat(err)}`));
      });
    });

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "rfetch-serve-webdav-"));
    source = join(home, "source");
    served = join(home, "served");
    mkdirSync(served);
    for (const [path, size] of Object.entries(FILES)) {
      mkdirSync(dirname(join(source, path)), { recursive: true });
      writeFileSync(join(source, path), content(size));
    }
    const response = await serve("webdav", served, { addr: "127.0.0.1:0" });
    reader = response.body.getReader();
    const { value } = await reader.read();
    const [url] = new TextDecoder().decode(value).match(/http:\/\/\S+/);
    target = `:webdav,url='${url}/':`;
  });

  after(async () => {
    await reader?.cancel();
    rmSync(home, { recursive: true, force: true });
  });

  test("rclone copies a folder to the server, and checks it", async () => {
    await rclone("copy", source, `${target}copy`);
    for (const [path, size] of Object.entries(FILES)) {
      assert.deepEqual(
        new Uint8Array(readFileSync(join(served, "copy", path))),
        content(size),
        path,
      );
    }
    await rclone("check", source, `${target}copy`);
  });

  test("rclone lists the files of the server", async () => {
    const list = JSON.parse(
      `${await rclone(
        "lsjson",
        "--recursive",
        "--files-only",
        `${target}copy`,
      )}`,
    );
    assert.deepEqual(
      Object.fromEntries(list.map(({ Path, Size }) => [Path, Size])),
      FILES,
    );
  });

  test("rclone reads a file and a range of it", async () => {
    const path = Object.keys(FILES)[4];
    const whole = await rclone("cat", `${target}copy/${path}`);
    assert.equal(whole.length, 3000);
    const part = await rclone(
      "cat",
      "--offset",
      "10",
      "--count",
      "5",
      `${target}copy/big.bin`,
    );
    assert.deepEqual(
      new Uint8Array(part),
      content(FILES["big.bin"]).subarray(10, 15),
    );
  });

  test("rclone copies and moves on the server", async () => {
    // The webdav backend of rclone sends COPY and MOVE.
    await rclone(
      "copyto",
      `${target}copy/a/one.bin`,
      `${target}copy/x/one.bin`,
    );
    await rclone("moveto", `${target}copy/x/one.bin`, `${target}copy/y.bin`);
    assert.deepEqual(
      new Uint8Array(readFileSync(join(served, "copy", "y.bin"))),
      content(1),
    );
    // A move of a folder.
    await rclone("move", `${target}copy/a`, `${target}moved`);
    await rclone("check", join(source, "a"), `${target}moved`);
  });

  test("rclone deletes files and folders", async () => {
    await rclone("deletefile", `${target}copy/y.bin`);
    await rclone("purge", `${target}moved`);
    await rclone("mkdir", `${target}empty`);
    await rclone("rmdir", `${target}empty`);
    const list = JSON.parse(`${await rclone("lsjson", target)}`);
    assert.deepEqual(list.map(({ Path }) => Path).sort(), ["copy"]);
  });
});
