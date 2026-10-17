import { test } from "node:test";
import assert from "node:assert/strict";
import { ls } from "./main.js";

test("ls", () => {
  assert(ls);
});
