import { assert } from "../../dev_deps.js";
import { backend } from "./main.js";

Deno.test("backend", () => {
  assert(backend);
});
