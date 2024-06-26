import { assert } from "../../dev_deps.js";
import { lsf } from "./main.js";

Deno.test("lsf", () => {
  assert(lsf);
});
