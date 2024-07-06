# denolcr

Deno port of Rclone, rewriting functionality using Web API.

A [Rclone wrapper for WebAssembly build](./rclone.js) is also available.

## Storage providers

- Google Drive [:page_facing_up:](https://rclone.org/drive/)
- HTTP [:page_facing_up:](https://rclone.org/http/)
- The local filesystem [:page_facing_up:](https://rclone.org/local/)
- Memory [:page_facing_up:](https://rclone.org/memory/)

### Virtual storage providers

These backends adapt or modify other storage providers

- Alias: rename existing remotes [:page_facing_up:](https://rclone.org/alias/)
- Chunker [:page_facing_up:](https://rclone.org/chunker/)
- Crypt: encrypt files [:page_facing_up:](https://rclone.org/crypt/)

## Commands

- `backend`
- `cat`
- `config`
- `copy`
- `copyurl`
- `ls`
- `lsd`
- `lsf`
- `lsjson`
- `lsl`
- `obscure`
- `rcat`
- `reveal`
- `serve`

## Development

- Clone the repository and navigate to the folder.
- `deno task start` to execute commands.
- Alternatively, `deno task install` to install a `dclone` executable in PATH
  that is symbolic linked to the `main.js` file and use `dclone` in place of
  `deno task start`.
- `deno task test` to run the test suites.
