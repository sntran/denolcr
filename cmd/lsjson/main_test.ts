import { assert } from "../../dev_deps.ts";
import { lsjson } from "./main.ts";

Deno.test("lsjson", () => {
  assert(lsjson);
});
