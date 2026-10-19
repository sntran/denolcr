import { test } from "node:test";
import assert from "node:assert/strict";

import { contents } from "../testing.js";
import { lsjson } from "../lsjson/main.js";
import { touch } from "./main.js";

test("touch makes an empty file, as rclone", async () => {
  assert.equal((await touch(":memory:/touch/new.txt")).status, 200);
  assert.deepEqual((await contents(":memory:/touch/")).files, {
    "new.txt": "",
  });
  assert.equal(
    (await touch(":memory:/touch/none.txt", { no_create: true })).status,
    200,
  );
  assert.deepEqual(Object.keys((await contents(":memory:/touch/")).files), [
    "new.txt",
  ]);
});

test("touch sets the time of a file, as rclone", async () => {
  /** @param {string} name */
  const timeOf = async (name) =>
    (await (await lsjson(":memory:/touch/")).json())
      .find((item) => item.Name === name)?.ModTime;
  // The time of a new file, in UTC.
  assert.equal(
    (await touch(":memory:/touch/t.txt", {
      timestamp: "2020-01-02T03:04:05",
    })).status,
    200,
  );
  assert.equal(await timeOf("t.txt"), "2020-01-02T03:04:05.000Z");
  // The time of a file that exists.
  assert.equal(
    (await touch(":memory:/touch/t.txt", { timestamp: "210203" })).status,
    200,
  );
  assert.equal(await timeOf("t.txt"), "2021-02-03T00:00:00.000Z");
  // Each file of a folder.
  assert.equal(
    (await touch(":memory:/touch/", {
      timestamp: "2022-03-04T05:06:07.5",
    })).status,
    200,
  );
  assert.equal(await timeOf("t.txt"), "2022-03-04T05:06:07.500Z");
  assert.equal(await timeOf("new.txt"), "2022-03-04T05:06:07.500Z");
  // As rclone: a year of two digits, and no part of a second in a text of
  // 19 characters.
  assert.equal(
    (await touch(":memory:/touch/t.txt", { timestamp: "991231" })).status,
    200,
  );
  assert.equal(await timeOf("t.txt"), "1999-12-31T00:00:00.000Z");
  for (
    const timestamp of [
      "yesterday",
      "2020-01-02",
      "201301",
      "2020-01-02T25:00:00",
      "2020-01-02T03:04:05.",
    ]
  ) {
    assert.equal(
      (await touch(":memory:/touch/t.txt", { timestamp })).status,
      400,
      timestamp,
    );
  }
});

test("touch gives the error of rclone for a backend that cannot set the time", async () => {
  const location = ":chunker,remote=':memory:/touch-chunker':a.txt";
  assert.equal((await touch(location)).status, 200);
  const response = await touch(location);
  assert.equal(response.status, 501);
  assert.equal(
    await response.text(),
    "failed to touch: can't set modified time",
  );
});
