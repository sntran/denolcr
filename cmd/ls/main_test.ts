import { assert } from "../../dev_deps.ts";
import { ls } from "./main.ts";

Deno.test("ls", () => {
  assert(ls);
});
