import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TIME, toListTime } from "@rfetch/lib/time";
import { fetch } from "../../fetch.js";
import { lsf } from "./main.js";

for (const name of ["a,b.txt", 'q"t.txt', " space.txt", "plain.txt"]) {
  await fetch(`:memory:/lsf/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: "x",
  });
}
await fetch(":memory:/lsf/sub/c.txt", { method: "PUT", body: "x" });

/** The lines of lsf, in order. */
async function lines(flags) {
  const text = await (await lsf(":memory:/lsf/", flags)).text();
  return text.split("\n").slice(0, -1).sort();
}

test("lsf gives the paths, with a / at the end of a folder", async () => {
  assert.deepEqual(await lines(), [
    " space.txt",
    "a,b.txt",
    "plain.txt",
    'q"t.txt',
    "sub/",
  ]);
  assert.deepEqual(await lines({ dir_slash: false, dirs_only: true }), [
    "sub",
  ]);
});

test("lsf --csv uses , and the quotes of CSV, as rclone", async () => {
  assert.deepEqual(
    await lines({ csv: true, format: "ps", files_only: true }),
    [
      '" space.txt",1',
      '"a,b.txt",1',
      "plain.txt,1",
      '"q""t.txt",1',
    ].sort(),
  );
  // With a separator, CSV uses it, and puts in quotes a value that has it.
  assert.deepEqual(
    await lines({ csv: true, format: "sp", separator: ";", files_only: true }),
    ['1;" space.txt"', "1;a,b.txt", "1;plain.txt", '1;"q""t.txt"'].sort(),
  );
});

test("lsf --format t gives the local time to the second, as rclone", async () => {
  const [line] = await lines({ format: "tp", separator: "|", dirs_only: true });
  assert.equal(line, `${toListTime(DEFAULT_TIME)}|sub/`);
  assert.match(line, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\|sub\/$/);
});
