import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { obscure } from "@rfetch/lib/obscure";
import { fetch } from "../../fetch.js";
import { captureLog, putFiles } from "../testing.js";
import { check, checksum, cryptcheck } from "./main.js";

const SOURCE = ":memory:/check/source/";
const TARGET = ":memory:/check/target/";

describe("check, checksum and cryptcheck", () => {
  beforeEach(async () => {
    await (await fetch(":memory:/check/", { method: "DELETE" })).body?.cancel();
    await putFiles(SOURCE, {
      "f.txt": "hello",
      "a/g.txt": "world!",
      "a/zero": "",
      "big.txt": "1234",
    });
    await putFiles(TARGET, {
      "f.txt": "HELLO",
      "a/zero": "",
      "big.txt": "12345",
      "extra": "x",
    });
  });

  test("check compares the sizes, as rclone with no common hash", async (t) => {
    const lines = captureLog(t);
    const response = await check(SOURCE, TARGET, { combined: "-" });
    assert.equal(response.status, 500);
    assert.equal(response.statusText, "3 differences found");
    assert.equal(
      await response.text(),
      "+ a/g.txt\n- extra\n= a/zero\n* big.txt\n= f.txt\n",
    );
    assert.deepEqual(lines, [
      `ERROR : a/g.txt: file not in ${TARGET}`,
      `ERROR : extra: file not in ${SOURCE}`,
      "ERROR : big.txt: sizes differ",
      `NOTICE: ${TARGET}: 1 files missing`,
      `NOTICE: ${SOURCE}: 1 files missing`,
      `NOTICE: ${TARGET}: 3 differences found`,
      `NOTICE: ${TARGET}: 3 errors while checking`,
      `NOTICE: ${TARGET}: 2 hashes could not be checked`,
      `NOTICE: ${TARGET}: 2 matching files`,
    ]);
  });

  test("check --download compares the bytes", async (t) => {
    const lines = captureLog(t);
    const response = await check(SOURCE, TARGET, {
      download: true,
      one_way: true,
      match: "-",
      differ: "-",
    });
    assert.equal(response.statusText, "3 differences found");
    assert.ok(lines.includes("ERROR : f.txt: contents differ"));
    assert.ok(!lines.some((line) => line.includes("extra")));
    assert.equal(await response.text(), "a/zero\nbig.txt\nf.txt\n");
  });

  test("check of the same files gives no error", async (t) => {
    captureLog(t);
    const response = await check(SOURCE, SOURCE, { download: true });
    assert.equal(response.status, 200);
  });

  test("checksum checks the files with a sum file", async (t) => {
    const lines = captureLog(t);
    await putFiles(":memory:/check/", {
      "MD5SUMS": "5d41402abc4b2a76b9719d911017c592  f.txt\n" +
        "00000000000000000000000000000000 *a/g.txt\n" +
        "d41d8cd98f00b204e9800998ecf8427e  gone.txt\n" +
        "not a line\n",
    });
    const response = await checksum("MD5", ":memory:/check/MD5SUMS", SOURCE);
    assert.equal(response.statusText, "3 differences found");
    for (
      const line of [
        "NOTICE: :memory:/check/MD5SUMS: improperly formatted checksum line 3",
        "ERROR : a/g.txt: files differ",
        "ERROR : a/zero: sum not found",
        "ERROR : big.txt: sum not found",
        `ERROR : gone.txt: file not in ${SOURCE}`,
        "NOTICE: 2 hashes missing",
        `NOTICE: ${SOURCE}: 1 matching files`,
      ]
    ) {
      assert.ok(lines.includes(line), `${line}\n${lines.join("\n")}`);
    }
  });

  test("cryptcheck compares a crypt remote with its source", async (t) => {
    captureLog(t);
    const password = await (await obscure("cryptcheck")).text();
    const crypted =
      `:crypt,remote=':memory:/check/crypted',password='${password}':`;
    await putFiles(crypted, { "f.txt": "hello", "a/g.txt": "world!" });
    await putFiles(":memory:/check/plain/", {
      "f.txt": "hello",
      "a/g.txt": "world!",
    });
    assert.equal(
      (await cryptcheck(":memory:/check/plain/", crypted)).status,
      200,
    );
    await putFiles(crypted, { "f.txt": "HELLO" });
    const differ = await cryptcheck(":memory:/check/plain/", crypted);
    assert.equal(differ.statusText, "1 differences found");
    assert.equal((await cryptcheck(SOURCE, TARGET)).status, 400);
  });
});
