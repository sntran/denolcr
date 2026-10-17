/**
 * The tests of the s3 backend against the s3 backend of rclone, on the same
 * `rclone serve s3`: each one reads what the other writes. The tests run
 * when rclone is in the PATH, or when RCLONE is the path of rclone.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { remote } from "@rfetch/testing/remote";
import { KEYS, serveS3 } from "./testing.js";
import s3 from "./main.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

/** The files: hard names, and sizes in one PUT and in parts. */
const FILES = {
  "empty.txt": 0,
  "a/one.bin": 1,
  "a/b/c.json": 100,
  "file name #1.txt": 2048,
  [`hello? sausage/êé/Hello, 世界/ " ' @ < > & ? + ≠/z.txt`]: 3000,
  "parts/large.bin": 6 * 1024 * 1024 + 7,
};

/** @param {number} size */
function content(size) {
  return new Uint8Array(size).map((_, index) => (index * 13 + size) & 0xff);
}

describe("s3 and rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  let server;
  /** The connection string of the s3 backend of rclone for the server. */
  let target;
  /** @param {string[]} args */
  const rclone = (...args) => {
    const { status, stdout, stderr } = spawnSync(RCLONE, args, {
      env: { PATH: process.env.PATH, HOME: server.folder },
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(status, 0, `rclone ${args[0]}: ${stderr}`);
    return stdout;
  };

  before(async () => {
    server = await serveS3();
    target = `:s3,provider=Other,access_key_id=${KEYS.access_key_id},` +
      `secret_access_key=${KEYS.secret_access_key},` +
      `endpoint='${server.endpoint}':rfetch`;
    for (const [path, size] of Object.entries(FILES)) {
      mkdirSync(dirname(join(server.folder, "plain", path)), {
        recursive: true,
      });
      writeFileSync(join(server.folder, "plain", path), content(size));
    }
  });
  after(() => server?.stop());

  const rfetch = (root) =>
    remote(s3, {
      params: { endpoint: server.endpoint, upload_cutoff: "1M" },
      env: {
        RCLONE_S3_ACCESS_KEY_ID: KEYS.access_key_id,
        RCLONE_S3_SECRET_ACCESS_KEY: KEYS.secret_access_key,
      },
      root,
    });

  /** The paths and the sizes of the files in a folder, from the lists. */
  async function walk(fs) {
    const files = [];
    const next = async (path) => {
      for (const entry of await fs.list(path)) {
        if (entry.IsDir) await next(`${path}${entry.Name}/`);
        else files.push({ Path: `${path}${entry.Name}`, Size: entry.Size });
      }
    };
    await next("");
    return files.sort((a, b) => a.Path < b.Path ? -1 : +(a.Path > b.Path));
  }

  test("rfetch reads what rclone writes", async () => {
    rclone("copy", join(server.folder, "plain"), `${target}/by-rclone`);
    const fs = rfetch("/rfetch/by-rclone/");
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
    const expected = JSON.parse(
      rclone("lsjson", "-R", "--files-only", `${target}/by-rclone`),
    ).map(({ Path, Size }) => ({ Path, Size }))
      .sort((a, b) => a.Path < b.Path ? -1 : +(a.Path > b.Path));
    assert.deepEqual(await walk(fs), expected);
  });

  test("rclone reads what rfetch writes", async () => {
    const fs = rfetch("/rfetch/by-rfetch/");
    for (const [path, size] of Object.entries(FILES)) {
      const response = await fs.put(path, content(size));
      assert.equal(response.status, 201, path);
    }
    rclone("check", join(server.folder, "plain"), `${target}/by-rfetch`);
    rclone("copy", `${target}/by-rfetch`, join(server.folder, "out"));
    for (const [path, size] of Object.entries(FILES)) {
      assert.deepEqual(
        new Uint8Array(readFileSync(join(server.folder, "out", path))),
        content(size),
        path,
      );
    }
  });

  test("rclone purge leaves nothing that rfetch lists", async () => {
    const fs = rfetch("/rfetch/by-rfetch/");
    assert.equal((await fs.delete("")).status, 204);
    rclone("purge", `${target}/by-rclone`);
    assert.deepEqual(await rfetch("/rfetch/").list(""), []);
  });
});
