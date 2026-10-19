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
- Combine: several remotes in one tree of folders
  [:page_facing_up:](https://rclone.org/combine/)
- Compress: compress files with gzip
  [:page_facing_up:](https://rclone.org/compress/)
- Crypt: encrypt files [:page_facing_up:](https://rclone.org/crypt/)
- Union: the merged contents of several remotes
  [:page_facing_up:](https://rclone.org/union/)

## rfetch as a service

`_worker.js` serves rfetch as a Worker of Cloudflare, at `rfetch.pages.dev`. It
is stateless: it keeps no configuration and no secret. The path of a request is
a remote and a path, as for the command, and the options come in the headers
`RFETCH_*`:

```sh
curl -H "RFETCH_CONFIG_R2_TYPE: s3" \
  -H "RFETCH_CONFIG_R2_ENDPOINT: https://ACCOUNT_ID.r2.cloudflarestorage.com" \
  -H "RFETCH_CONFIG_R2_ACCESS_KEY_ID: …" \
  -H "RFETCH_CONFIG_R2_SECRET_ACCESS_KEY: …" \
  -H "Accept: application/json" \
  https://rfetch.pages.dev/r2:bucket/folder/
```

With `Accept: application/json`, a `GET` gives the list of `rfetch lsjson`, and
`Depth: N` lists N levels. Else a folder is an HTML page, and a file is its
bytes, with ranges. The prefix `RCLONE_` of rclone also works.

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

## Runtimes

rfetch runs on Node.js 22.2 or later, on Deno and on Bun 1.4 or later:

```sh
node main.js COMMAND ...
deno run -A main.js COMMAND ...
bun main.js COMMAND ...
```

Bun 1.3 cannot read the list of a local folder: its HTMLRewriter gives the error
`Failed to pipe stream`.

`node bench/rclone.js RUNTIME...` runs the same commands with rfetch on each
runtime and with rclone, and first makes sure that they give the same data and
the same lists. Each time is the median of 5 runs of the command as a new
process, in ms, thus the start of the runtime is in it. The table is one run on
a Linux machine with 4 CPUs (Intel Xeon at 2.10 GHz) and rclone 1.75.1. The
times on one machine can change by 10 to 25 % from one run to the next, also for
rclone. Run the benchmark on your machine to choose a runtime.

| Command, in ms                             | Node.js 22.22 | Node.js 24.21 | Node.js 26.12 | Deno 2.9.6 | Bun 1.4.3 | rclone 1.75.1 |
| ------------------------------------------ | ------------: | ------------: | ------------: | ---------: | --------: | ------------: |
| `lsjson` of an empty folder                |           135 |           130 |           142 |        108 |        48 |            57 |
| local: `cat` of 64 MiB                     |           166 |           187 |           176 |        155 |        90 |            90 |
| local: `lsjson --recursive`, 1000 files    |           267 |           249 |           226 |        212 |        73 |            50 |
| crypt: `cat` of 64 MiB                     |           383 |           395 |           416 |        411 |       402 |           228 |
| crypt: `rcat` of 64 MiB                    |           469 |           449 |           429 |        535 |       461 |           443 |
| crypt: `lsjson --recursive`, 1000 files    |           387 |           347 |           346 |        347 |       160 |           113 |
| chunker: `cat` of 64 MiB, chunks of 8 MiB  |           235 |           209 |           220 |        188 |       113 |            81 |
| chunker: `rcat` of 64 MiB, chunks of 8 MiB |           377 |           364 |           363 |        474 |       285 |           380 |

- `lsjson` of an empty folder shows the time of the start.
- crypt and chunker are on top of local files. rclone writes the files that
  rfetch reads.
- Deno gives the time of a local file to the millisecond. The other runtimes and
  rclone give it to the nanosecond.
- In Bun and in a Cloudflare Worker, HTMLRewriter is a part of the runtime. In
  Node.js and in Deno, it is WebAssembly, which loads when a command reads the
  first list.

## Development

- Clone the repository and go to its folder.
- `npm install` to get the dependencies (Node.js 22.2 or later).
- `npm start -- COMMAND ...` to run a command.
- Alternatively, `npm link` to install a `rfetch` program in the PATH, with a
  symbolic link to `main.js`, and use `rfetch` in place of `npm start --`.
- `npm test` to run the tests, with the test runner of Node.js.
- `npm run bench` to compare some commands with `rclone`, which must be in the
  PATH.
- `node bench/node.js` to measure the time of the backends, and
  `node bench/rclone.js` to compare the commands with rclone. See
  [CONTRIBUTING.md](CONTRIBUTING.md#benchmarks) for the benchmark in a Worker.
