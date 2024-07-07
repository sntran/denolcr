import { test } from "node:test";
import { assert } from "../../dev_deps.js";
import { lsd } from "./main.js";

test("lsd", () => {
  assert(lsd);
});
