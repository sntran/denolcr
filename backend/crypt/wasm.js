/**
 * The module of `secretbox.wasm` for Node.js, Deno and Bun: they read the
 * file and compile it. A Worker cannot compile a module at run time, thus it
 * imports `wasm.workerd.js` in place of this file (the field `imports` of
 * `package.json`).
 */
import { readFileSync } from "node:fs";

export default new WebAssembly.Module(
  readFileSync(new URL("./secretbox.wasm", import.meta.url)),
);
