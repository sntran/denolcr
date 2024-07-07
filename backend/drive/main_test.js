import { test } from "node:test";
import { assert } from "../../dev_deps.js";
import backend from "./main.js";

test("GET", () => {
  assert(backend.fetch);
});
