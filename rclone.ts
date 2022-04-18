import "https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/js/wasm_exec.js";

// A Rclone instance from a compiled WebAssemble module.
export class Rclone extends WebAssembly.Instance {
  constructor(module: WebAssemble.Module) {
    // Patches for rclone.
    globalThis.document = {};
    globalThis.rcValidResolve = function() {
      // Invoked by rclone at the end of initialization.
    }
    // Instantiates WASM module.
    const go = new globalThis.Go(); // From `wasm_exec.js`
    super(module, go.importObject);
    go.run(this);
  }

  rc(command: string, args: object): object {
    return globalThis.rc(command, args);
  }
}
