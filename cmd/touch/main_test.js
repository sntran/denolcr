import { test } from "node:test";
import assert from "node:assert/strict";

import { contents } from "../testing.js";
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

test("touch tells that the backends cannot set the time yet", async () => {
  const response = await touch(":memory:/touch/new.txt");
  assert.equal(response.status, 501);
  assert.equal(
    await response.text(),
    "failed to touch: can't set modified time",
  );
  const timestamp = await touch(":memory:/touch/t.txt", {
    timestamp: "2020-01-02T03:04:05",
  });
  assert.equal(timestamp.status, 501);
  assert.equal(
    (await touch(":memory:/touch/t.txt", { timestamp: "yesterday" })).status,
    400,
  );
});
