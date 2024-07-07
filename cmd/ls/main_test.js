import { test } from "node:test";
import { assert } from "../../dev_deps.js";
import { ls } from "./main.js";

test("ls", () => {
  assert(ls);
});
