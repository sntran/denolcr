import { assert } from "../../dev_deps.js";
import { rcat } from "./main.js";

Deno.test("rcat", () => {
  assert(rcat);
});
