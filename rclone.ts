import "https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/js/wasm_exec.js";

// Provides a default WASM module.
const wasm = await WebAssembly.compileStreaming(
  fetch(new URL("./rclone.wasm", import.meta.url))
);

// A Rclone instance from a compiled WebAssemble module.
export class Rclone extends WebAssembly.Instance {
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

  rc(command: string, args: object): object {
    // @ts-ignore
    return globalThis.rc(command, args);
  }
}
