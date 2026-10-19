import { test } from "node:test";
import assert from "node:assert/strict";

import { contents } from "../testing.js";
import { mkdir } from "./main.js";

test("mkdir makes a folder and the folders above it", async () => {
  assert.equal((await mkdir(":memory:/mkdir/a/b c/d")).status, 200);
  assert.deepEqual((await contents(":memory:/mkdir/")).folders, [
    "a",
    "a/b c",
    "a/b c/d",
  ]);
  // A folder that exists is not an error.
  assert.equal((await mkdir(":memory:/mkdir/a")).status, 200);
});
