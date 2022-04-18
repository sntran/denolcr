# denolcr

Deno web interface to Rclone, using WebAssembly build.

## Usage

```ts
import { Rclone } from "https://raw.githubusercontent.com/sntran/denolcr/main/rclone.ts";

const module = await WebAssembly.compileStreaming(fetch("https://sntran.github.io/denolcr/rclone.wasm"));
const rclone = new Rclone(module);

rclone.rc("core/version");
```
