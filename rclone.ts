// Copyright 2018-2021 Trần Nguyễn Sơn. All rights reserved. MIT license.
import "https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/js/wasm_exec.js";

function compile(url: string): Promise<WebAssembly.Module> {
  url = new URL(url, import.meta.url).href;
  return WebAssembly.compileStreaming(fetch(url));
}

/** Provides a default WASM module. */
const wasm = await compile("./rclone.wasm");

/** A Rclone instance from a compiled WebAssemble module. */
export class Rclone extends WebAssembly.Instance {
  static async from(url: string): Promise<Rclone> {
    const module = await compile(url);
    return new Rclone(module);
  }

  /**
   * Create a rclone instance.
   */
  constructor(module: WebAssembly.Module = wasm) {
    // @ts-ignore: Patches for rclone.
    globalThis.document ??= {};
    // @ts-ignore: Patches for rclone.
    globalThis.rcValidResolve ??= function () {
      // Invoked by rclone at the end of initialization.
    };
    // @ts-ignore: Instantiates WASM module.
    const go = new globalThis.Go(); // From `wasm_exec.js`

    super(module, go.importObject);

    go.run(this);
  }

  /**
   * Remote controls rclone
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
  rc(
    command: string,
    args: Record<string, unknown> | null = null,
  ): Record<string, unknown> {
    // @ts-ignore: Use global `rc` function.
    return globalThis.rc(command, args);
  }
}
