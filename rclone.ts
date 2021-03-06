// Copyright 2018-2021 Trần Nguyễn Sơn. All rights reserved. MIT license.
import "https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/js/wasm_exec.js";

/** Provides a default WASM module. */
const wasm = await WebAssembly.compileStreaming(
  fetch(new URL("./rclone.wasm", import.meta.url))
);

/** A Rclone instance from a compiled WebAssemble module. */
export class Rclone extends WebAssembly.Instance {
  /**
   * Create a rclone instance.
   */
  constructor(module: WebAssembly.Module = wasm) {
    // Patches for rclone.
    // @ts-ignore
    globalThis.document ??= {};
    // @ts-ignore
    globalThis.rcValidResolve ??= function() {
      // Invoked by rclone at the end of initialization.
    }
    // Instantiates WASM module.
    // @ts-ignore
    const go = new globalThis.Go(); // From `wasm_exec.js`

    super(module, go.importObject);

    go.run(this);
  }

  /** Remote controls rclone
   *
   * ```ts
   * import { Rclone } from "https://deno.land/x/rclone@v0.0.2/mod.ts";
   * const { rc } = new Rclone();
   * console.log("core/version", rc("core/version", null))
   * console.log("rc/noop", rc("rc/noop", {"string":"one",number:2}))
   * console.log("operations/mkdir", rc("operations/mkdir", {"fs":":memory:","remote":"bucket"}))
   * console.log("operations/list", rc("operations/list", {"fs":":memory:","remote":"bucket"}))
   * ```
   */
  rc(command: string, args: object): object {
    // @ts-ignore
    return globalThis.rc(command, args);
  }
}
