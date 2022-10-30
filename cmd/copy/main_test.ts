import { assert } from "../../dev_deps.ts";
import { copy } from "./main.ts";

Deno.test("copy", () => {
  assert(copy);
});
