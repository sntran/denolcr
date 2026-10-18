import { test } from "node:test";
import assert from "node:assert/strict";
import { cat } from "./main.js";

test("cat", () => {
  assert(cat);
});
