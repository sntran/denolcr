import { assert } from "../../dev_deps.ts";
import { copyurl } from "./main.ts";

Deno.test("copyurl", () => {
  assert(copyurl);
});
