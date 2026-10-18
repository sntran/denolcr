import { test } from "node:test";
import assert from "node:assert/strict";

import { toListTime } from "@rfetch/lib/time";
import { fetch } from "../../fetch.js";
import { lsjson } from "../lsjson/main.js";
import { lsl } from "./main.js";

await fetch(":memory:/lsl/a.txt", { method: "PUT", body: "hello" });

test("lsl gives the size, the local time to the nanosecond and the path, as rclone", async () => {
  const [{ ModTime }] = await (await lsjson(":memory:/lsl/")).json();
  const text = await (await lsl(":memory:/lsl/")).text();
  assert.equal(text, `        5 ${toListTime(ModTime, 9)} a.txt\n`);
  assert.match(
    text,
    /^ {8}5 \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{9} a\.txt\n$/,
  );
});
