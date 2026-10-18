import { test } from "node:test";
import assert from "node:assert/strict";
import { backend } from "./main.js";

test("backend", () => {
  assert(backend);
});
