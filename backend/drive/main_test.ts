import { assert } from "../../dev_deps.ts";
import { fetch } from "./main.ts";

Deno.test("fetch", () => {
  assert(fetch);
});
