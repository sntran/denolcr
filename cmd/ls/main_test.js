import { test } from "node:test";
import assert from "node:assert/strict";

import { fetch } from "../../fetch.js";
import { ls } from "./main.js";

await fetch(":memory:/ls/a.txt", { method: "PUT", body: "hello" });
await fetch(":memory:/ls/sub/b.bin", {
  method: "PUT",
  body: new Uint8Array(123456),
});

test("ls gives the size in 9 characters and the path of each file, as rclone", async () => {
  const text = await (await ls(":memory:/ls/")).text();
  assert.equal(text, "        5 a.txt\n   123456 sub/b.bin\n");
});

test("ls --human-readable gives the size with a suffix of rclone", async () => {
  const response = await ls(":memory:/ls/", { human_readable: true });
  assert.equal(await response.text(), "        5 a.txt\n120.562Ki sub/b.bin\n");
});

test("ls --max-depth 1 lists only the files of the folder", async () => {
  const response = await ls(":memory:/ls/", { max_depth: "1" });
  assert.equal(await response.text(), "        5 a.txt\n");
});
