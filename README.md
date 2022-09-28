# denolcr

Deno web interface to Rclone, using WebAssembly build.

## Usage

```ts
import { Rclone } from "https://raw.githubusercontent.com/sntran/denolcr/main/rclone.ts";

const rclone = new Rclone();
rclone.rc("core/version");
```

By default, the provided [`rclone.wasm`](rclone.wasm) module is used. This can
be changed by providing another compiled module in the constructor. For example:

```ts
import { Rclone } from "https://raw.githubusercontent.com/sntran/denolcr/main/rclone.ts";
const rclone = Rclone.from("https://sntran.github.io/denolcr/rclone.wasm");
rclone.rc("core/version");
```

The default module provides the following backends:

- alias
- chunker
- crypt
- ftp
- http
- memory
- union
