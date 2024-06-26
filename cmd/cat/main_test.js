import { assert } from "../../dev_deps.js";
import { cat } from "./main.js";

Deno.test("cat", () => {
  assert(cat);
});
