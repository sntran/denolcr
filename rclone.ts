// deno-lint-ignore-file no-var
// Copyright 2018-2021 Trần Nguyễn Sơn. All rights reserved. MIT license.
import "https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/js/wasm_exec.js";

declare class Go {
  argv: string[];
  env: { [envKey: string]: string };
  exit: (code: number) => void;
  importObject: WebAssembly.Imports;
  exited: boolean;
  mem: DataView;
  run(instance: WebAssembly.Instance): Promise<void>;
}

declare global  {
  var document: Record<string, unknown>;
  function rcValidResolve(): void;
  var Go: Go;
  function rc(command: string, params: Record<string, unknown> | null): void;
}

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
    globalThis.document ??= {};
    globalThis.rcValidResolve ??= function() {
      // Invoked by rclone at the end of initialization.
    }
    // Instantiates WASM module.
    const go = new Go(); // From `wasm_exec.js`

    super(module, go.importObject);

    go.run(this);
  }

  /** Remote controls rclone
   *
   * ```ts
   * import { Rclone } from "./rclone.ts";
   * const { rc } = new Rclone();
   * console.log("core/version", rc("core/version", null))
   * console.log("rc/noop", rc("rc/noop", {"string":"one",number:2}))
   * console.log("operations/mkdir", rc("operations/mkdir", {"fs":":memory:","remote":"bucket"}))
   * console.log("operations/list", rc("operations/list", {"fs":":memory:","remote":"bucket"}))
   * ```
   */
  rc(command: string, args: Record<string, unknown> |  null) {
    return globalThis.rc(command, args);
  }
}

// Learn more at https://deno.land/manual/examples/module_metadata#concepts
if (import.meta.main) {
  const { rc } = new Rclone();
  const [command, ...args] = Deno.args;
  const params: Record<string, string|number> = {};

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
