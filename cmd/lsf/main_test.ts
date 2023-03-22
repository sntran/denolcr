import { assert } from "../../dev_deps.ts";
import { lsf } from "./main.ts";

Deno.test("lsf", () => {
  assert(lsf);
});
