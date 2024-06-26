import { assert } from "../../dev_deps.js";
import { ls } from "./main.js";

Deno.test("ls", () => {
  assert(ls);
});
