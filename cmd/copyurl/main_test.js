import { assert } from "../../dev_deps.js";
import { copyurl } from "./main.js";

Deno.test("copyurl", () => {
  assert(copyurl);
});
