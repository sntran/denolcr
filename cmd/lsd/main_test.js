import { assert } from "../../dev_deps.js";
import { lsd } from "./main.js";

Deno.test("lsd", () => {
  assert(lsd);
});
