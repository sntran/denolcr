# denolcr

Deno port of Rclone, rewriting functionality using Web API.

A [Rclone wrapper for WebAssembly build](./rclone.ts) is also available.

## Storage providers

- Fshare.vn
- Google Drive [:page_facing_up:](https://rclone.org/drive/)
- The local filesystem [:page_facing_up:](https://rclone.org/local/)

### Virtual storage providers

These backends adapt or modify other storage providers

- Alias: rename existing remotes [:page_facing_up:](https://rclone.org/alias/)
- Crypt: encrypt files [:page_facing_up:](https://rclone.org/crypt/)

## Commands

- `backend`
- `config`
- `lsjson`
- `lsf`
- `ls`
- `lsl`
- `lsd`
- `cat`
- `rcat`
- `copy`
- `copyurl`
- `obscure`
- `reveal`

## Development

- Clone the repository and navigate to the folder.
- `deno task start` to execute commands.
- Alternatively, `deno task install` to install a `dclone` executable in PATH
  that is symbolic linked to the `main.ts` file and use `dclone` in place of
  `deno task start`.
- `deno task test` to run the test suites.
