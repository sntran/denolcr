import { before, test } from "node:test";
import assert from "node:assert/strict";

import { fetch } from "../../fetch.js";
import { putFiles } from "../testing.js";
import { hashsum, md5sum, sha1sum } from "./main.js";

const ROOT = ":memory:/hashsum/";

before(async () => {
  await putFiles(ROOT, { "f.txt": "hello", "a/g.txt": "world!", "a/zero": "" });
});

/** @param {Response} response */
async function lines(response) {
  assert.equal(response.status, 200);
  return (await response.text()).split("\n").filter(Boolean).sort();
}

test("md5sum and sha1sum give the sums of the files, as rclone", async () => {
  assert.deepEqual(await lines(await md5sum(ROOT)), [
    "08cf82251c975a5e9734699fadf5e9c0  a/g.txt",
    "5d41402abc4b2a76b9719d911017c592  f.txt",
    "d41d8cd98f00b204e9800998ecf8427e  a/zero",
  ]);
  assert.deepEqual(await lines(await sha1sum(`${ROOT}f.txt`)), [
    "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d  f.txt",
  ]);
});

test("hashsum gives the hashes of rclone", async () => {
  assert.deepEqual(await lines(await hashsum("SHA-256", `${ROOT}f.txt`)), [
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  f.txt",
  ]);
  assert.deepEqual(await lines(await hashsum("crc32", ROOT)), [
    "00000000  a/zero",
    "3610a686  f.txt",
    "718498e8  a/g.txt",
  ]);
  assert.deepEqual(
    await lines(await hashsum("md5", `${ROOT}f.txt`, { base64: true })),
    ["XUFAKrxLKna5cZ2REBfFkg==  f.txt"],
  );
  assert.match(
    await (await hashsum({})).text(),
    /^Supported hashes are:\n- md5\n/,
  );
  assert.equal((await hashsum("whirlpool", ROOT)).status, 400);
});

test("hashsum writes an output file, and checks a sum file", async () => {
  const out = `${ROOT}sums/MD5SUMS`;
  assert.equal(
    await (await md5sum(`${ROOT}a/`, { output_file: out })).text(),
    "",
  );
  const sums = await (await fetch(out)).text();
  assert.match(sums, /^08cf82251c975a5e9734699fadf5e9c0 {2}g\.txt$/m);
  const checked = await md5sum(`${ROOT}a/`, { checkfile: out, quiet: true });
  assert.equal(checked.status, 200);
});
