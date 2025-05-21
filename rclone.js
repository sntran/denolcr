// Copyright 2018-2021 Trần Nguyễn Sơn. All rights reserved. MIT license.
/**
 * Deno wrapper for rclone using WebAssembly build.
 *
 * @example
 * ```ts
 * import { Rclone } from "./rclone.js";
 *
 * const rclone = new Rclone();
 * rclone.rc("core/version");
 * ```
 *
 * By default, provided [rclone.wasm](./rclone.wasm)
 * module is used. This can be changed by providing another compiled module in
 * the constructor.
 *
 * @example
 * ```ts
 * import { Rclone } from "./rclone.js";
 *
 * const module = await WebAssembly.compileStreaming(fetch("https://deno.land/x/rclone/rclone.wasm"));
 * const rclone = new Rclone(module);
 *
 * rclone.rc("core/version");
 * ```
 *
 * The default module provides the following backends:
 *
 * - alias
 * - chunker
 * - crypt
 * - ftp
 * - http
 * - memory
 * - union
 */
import process from "node:process";
import "https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/js/wasm_exec.js";

/** Provides a default WASM module. */
const wasm = await WebAssembly.compileStreaming(
  fetch(new URL("./rclone.wasm", import.meta.url)),
);

/** A Rclone instance from a compiled WebAssemble module. */
export class Rclone extends WebAssembly.Instance {
  /**
   * Create a rclone instance.
   * @param {WebAssembly.Module} [module] A WebAssembly module to use.
   */
  constructor(module = wasm) {
    // Patches for rclone.
    globalThis.document ??= {};
    globalThis.rcValidResolve ??= function () {
      // Invoked by rclone at the end of initialization.
    };
    // Instantiates WASM module.
    const go = new Go(); // From `wasm_exec.js`

    super(module, go.importObject);

    go.run(this);
  }

  /** Remote controls rclone
   *
   * ```ts
   * import { Rclone } from "./rclone.js";
   * const { rc } = new Rclone();
   * console.log("core/version", rc("core/version", null))
   * console.log("rc/noop", rc("rc/noop", {"string":"one",number:2}))
   * console.log("operations/mkdir", rc("operations/mkdir", {"fs":":memory:","remote":"bucket"}))
   * console.log("operations/list", rc("operations/list", {"fs":":memory:","remote":"bucket"}))
   * ```
   *
   * @param {string} command The command to run.
   * @param {Object|null} [args]
   */
  rc(command, args) {
    return globalThis.rc(command, args);
  }
}

if (import.meta.main) {
  const { rc } = new Rclone();
  const [, , command, ...args] = process.argv;
  const params = {};

  let argCount = args.length;
  while (argCount--) {
    const arg = args[argCount];
    if (arg.includes("=")) {
      const [key, value] = arg.split("=");
      if (isNaN(Number(value))) {
        params[key] = value;
      } else {
        params[key] = Number(value);
      }
      args.splice(argCount, 1);
    }
  }

  console.log(rc(command, params));
}
