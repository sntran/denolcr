import { assert } from "../../dev_deps.ts";
import { rcat } from "./main.ts";

Deno.test("rcat", () => {
  assert(rcat);
});
