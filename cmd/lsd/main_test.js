import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TIME, toListTime } from "@rfetch/lib/time";
import { fetch } from "../../fetch.js";
import { lsd } from "./main.js";

await fetch(":memory:/lsd/a.txt", { method: "PUT", body: "a" });
await fetch(":memory:/lsd/sub/deep/b.txt", { method: "PUT", body: "b" });

// A folder of memory has no time: it has the default time of rclone.
const time = toListTime(DEFAULT_TIME);

test("lsd gives the folders of one level, as rclone", async () => {
  const text = await (await lsd(":memory:/lsd/")).text();
  assert.equal(text, `          -1 ${time}        -1 sub\n`);
});

test("lsd --recursive gives the folders of each level", async () => {
  const response = await lsd(":memory:/lsd/", { recursive: true });
  assert.equal(
    await response.text(),
    `          -1 ${time}        -1 sub\n          -1 ${time}        -1 sub/deep\n`,
  );
});

test("lsd --human-readable gives fields of 9 and 8 characters", async () => {
  const response = await lsd(":memory:/lsd/", { human_readable: true });
  assert.equal(await response.text(), `       -1 ${time}       -1 sub\n`);
});
