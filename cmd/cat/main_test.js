import { test } from "node:test";
import { assert } from "../../dev_deps.js";
import { cat } from "./main.js";

test("cat", () => {
  assert(cat);
});
