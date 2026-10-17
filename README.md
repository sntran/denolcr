# rfetch

Fetching between remotes, using Web APIs.

This is a rewrite of Rclone, using modern Web APIs for cross runtimes.

A [Rclone wrapper for WebAssembly build](./rclone.js) is also available.

## Storage providers

- Google Drive [:page_facing_up:](https://rclone.org/drive/)
- HTTP [:page_facing_up:](https://rclone.org/http/)
- The local filesystem [:page_facing_up:](https://rclone.org/local/)
- Memory [:page_facing_up:](https://rclone.org/memory/)
- S3: Amazon S3 and the services with the same API, for example Cloudflare R2
  [:page_facing_up:](https://rclone.org/s3/)

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

- Clone the repository and go to its folder.
- `npm install` to get the dependencies (Node.js 22.2 or later).
- `npm start -- COMMAND ...` to run a command.
- Alternatively, `npm link` to install a `rfetch` program in the PATH, with a
  symbolic link to `main.js`, and use `rfetch` in place of `npm start --`.
- `npm test` to run the tests, with the test runner of Node.js.
- `npm run bench` to compare some commands with `rclone`, which must be in the
  PATH.
