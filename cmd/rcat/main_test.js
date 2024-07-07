import { test } from "node:test";
import { assert } from "../../dev_deps.js";
import { rcat } from "./main.js";

test("rcat", () => {
  assert(rcat);
});
