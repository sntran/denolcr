import { assert } from "../../dev_deps.ts";
import { cat } from "./main.ts";

Deno.test("cat", () => {
  assert(cat);
});
