import { assert } from "../../dev_deps.ts";
import { lsd } from "./main.ts";

Deno.test("lsd", () => {
  assert(lsd);
});
