import { assert } from "../../dev_deps.ts";
import { backend } from "./main.ts";

Deno.test("backend", () => {
  assert(backend);
});
