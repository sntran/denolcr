# Contributing to rfetch

This is a short guide on how to contribute things to rfetch.

## Writing a new backend

Choose a name. The docs here will use `remote` as an example.

Note that in rfetch terminology a file system backend is called a remote or an
fs.

- Make the folder "backend/remote" with the files "package.json", "main.js" and
  "main_test.js" for the new backend. The tests use the test runner of Node.js
  (`node:test`).
- Add the backend to `backends` in `backend/main.js`, as
  `remote: () => import("@rfetch/remote")`, and to the `dependencies` of the
  root "package.json". rfetch loads a backend at its first use.
- Implements a `fetch` default export function that handles "GET", "PUT" and
  "DELETE".
- Uses `backend/local/main.js` as reference, or the boilerplate below:

```ts
import { join } from "node:path";

function router(request: Request) {
  const { method, url } = request;
  const { pathname, searchParams } = new URL(url);

  const headers = new Headers();
  let status = 200, body = null;

  if (method === "HEAD" || method === "GET") {
    // Retrieves file or folder info.
  }

  if (method === "GET") {
    // Retrieves file content.
    body = new ReadableStream();
  }

  if (method === "PUT") {
    // Folder ending with trailing slash.
    if (pathname.endsWith("/")) {
      // Creates folder.
    } else {
      // Creates file.
    }

    status = 201;
    headers.append("Content-Location", pathname);
  }

  if (method === "DELETE") {
    status = 204;
  }

  return new Response(body, {
    status,
    headers,
  });
}\

export default {
  fetch: router,
};
```

A backend imports nothing of rfetch, for example `mod.js`. It is a Worker of
Cloudflare: it gets all from the request and from `env`, the second argument of
`fetch`. A backend on top of another remote, for example `crypt` or `chunker`,
sends its requests to that remote with the global `fetch`, for example
`fetch(":memory:/crypt/file.bin")`. The host sets the global `fetch` that reads
such a path: the import of `fetch.js` sets it. `mod.js`, the commands and
`_worker.js` import `fetch.js`. The tests of such a backend import `mod.js`:

```js
// Sets the global `fetch` that reads the paths of remotes.
import "../../mod.js";

backendSuite("crypt", crypt, {
  params: { remote: ":memory:/crypt", password },
});
```

To count or change the requests to the remote in a test, replace the global
`fetch` with `t.mock.method(globalThis, "fetch", …)`. The test runner puts the
original `fetch` back at the end of the test.

## Options of a backend

A backend reads its options with `optionsOf(request, "remote", env)` of
`@rfetch/lib/options`, in this order:

1. a field of the query, for example `?password=…`;
2. the header `RFETCH_REMOTE_NAME` of the request, for example
   `RFETCH_CRYPT_PASSWORD`;
3. the variable `RFETCH_REMOTE_NAME` of `env`.

The prefix `RCLONE_` of rclone also works, for compatibility, for example
`RCLONE_CRYPT_PASSWORD`. In each place, `RFETCH_` takes the place of `RCLONE_`.
Thus a client can give a secret in a header, and a Worker can give it in `env`:
then the secret is not in a URL. A backend makes the links of a list from the
query of the request only, with no secret option. Thus an option of a header or
of `env` is never in a link.

A backend on top of another remote sends the headers
`remoteHeaders(request.headers, "remote", remote)` to that remote. The other
options of the request go on, for example a remote `RFETCH_CONFIG_NAME_TYPE`
that only the headers tell. The options of the backend itself do not go. When
the remote is a URL, no option goes: a secret must not go out to a server.

The `fetch` of `fetch.js` reads the headers `RFETCH_*` and `RCLONE_*` of a
request as the variables, in the place of the variables of the process. A remote
can come only from variables: `RFETCH_CONFIG_NAME_TYPE` and its options, as in
rclone. The backend gets the options of the path, the connection string and the
flags, in its query, and all the other options in `env`, as
`RFETCH_REMOTE_NAME`. The headers `RFETCH_*` and `RCLONE_*` never go out to a
URL.

A local path, for example `file.txt`, `../file.txt` or `/tmp/file.txt`, is
relative to the current folder, as in rclone. The `fetch` of `fetch.js` gives
the absolute path to the local backend, with `RFETCH_LOCAL_ROOT: /` in `env`.
`RFETCH_LOCAL_ROOT` is not an option: a config file, a variable, a header or the
query cannot set it. Thus `:local:path` and a client of `rfetch serve` stay in
the current folder.

## Workspaces

Each backend is an npm workspace with the name `@rfetch/NAME`, and can be a
Worker of its own: "main.js" is the entry of the Worker. The "package.json" of a
new backend is:

```json
{
  "name": "@rfetch/remote",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./main.js" },
  "scripts": { "test": "node --test" },
  "dependencies": { "@rfetch/lib": "^0.1.0" }
}
```

Then run `npm install`: npm links the workspace into `node_modules`.

A backend imports only:

- the modules `node:` of Node.js,
- the packages of its "package.json", for example `@rfetch/lib/listing`,
- the files in its folder.

The tests and the benches of a backend can also import its `devDependencies`,
and `../../mod.js` for the global `fetch`. The test `backend/main_test.js` makes
sure of this rule.

The code that two or more backends use is in the workspace `lib`, the package
`@rfetch/lib`: for example `listing`, `path`, `range`, `mime` and `obscure`. The
shared tests of the backends are in it too, in `@rfetch/lib/testing/suite`. The
code that only one backend uses is in the folder of that backend, for example
`backend/s3/xml.js`.

## Architecture

- `GET /folder/`: displays HTML page with folder content.
- `GET /file`: fetches file.
- `HEAD /folder/` and `HEAD /file`: the same headers as `GET`, with no body.
- `PUT /folder/`: creates folder.
- `PUT /file`: uploads file. `PUT` creates the parent folders that do not exist.
- `DELETE /folder/`: deletes folder, and all the files and folders in it.
- `DELETE /file`: deletes file.

The answers:

- `PUT` gives 201 with the path in `Content-Location`. `DELETE` gives 204.
- A file or a folder that does not exist gives 404.
- `GET` of a file gives the headers `Content-Type`, `Content-Length`,
  `Last-Modified` and `Accept-Ranges: bytes`.
- `GET` with `Range: bytes=START-END` gives 206 with the bytes of the range,
  `Content-Range` and the `Content-Length` of the range, as RFC 9110. A range
  with no byte of the file gives 416. A request with more ranges, or with a
  range that is not correct, gets all the file. Use `parseRange` of
  `@rfetch/lib/range`.

The path of a request has percent-encoding. Use `decodePath` of
`@rfetch/lib/path` to get the path with no percent-encoding. It gives `null` for
a path that is not safe, for example `/..%2Fsecret.txt`, which becomes
`/../secret.txt` after the decoding. For `null`, give 400.

For displaying folder content, any HTML can be used, but the listing itself
should be in a `<table>`, whose each rows are for each file or folder inside.
Each items should have a `<a>` whose `href` attribute points to the file or
folder, and optionally a `type` attribute to tell the item's mime-type. A
`<data>` element should be used for file size, and `<time>` for file
modification time.

- The `href` is the name with percent-encoding (`encodeURIComponent`), with a
  `/` at the end for a folder.
- The text of the link is the name with `escapeHTML` of `@rfetch/lib/html`. Do
  not put a name in the HTML with no escape: a file with the name `<script>.txt`
  must not add a script to the page.
- `<data value>` is the size in bytes, for a file only.
- `<time datetime>` is the time in ISO 8601.

`renderListing` of `@rfetch/lib/listing` writes such a list from the entries of
a folder, and `readListing` reads it.

A backend on top of another backend reads the list of the other backend with
`readListing`, changes the entries, and writes the list with `renderListing`,
for example the names of `crypt`. `lsjson` reads each list with `readListing`.

Read HTML only with `readElements` of `@rfetch/lib/rewriter`. It is
HTMLRewriter, that is lol-html, the HTML parser of Cloudflare, as the HTML
standard tells. Do not write a parser of HTML: a list can come from any server,
and its HTML can have scripts, comments and character references. HTMLRewriter
gives the value of an attribute as it is in the document: read it with
`attributeOf`, which decodes the character references, for example `&amp;`. In
workerd and in Bun, HTMLRewriter is a part of the runtime. In Node.js and in
Deno, it is the WebAssembly of `@sntran/lol-html`, which loads at its first use.

## Commands

Each command is a function of a module in `cmd`, for example `cat` of
`cmd/cat/main.js` and `reveal` of `cmd/obscure/main.js`. A new command goes in
`cmd/main.js`, for `mod.js`, and in `cmd/folders.js`, for the command line:
`main.js` loads only the module of its command, because the load of all the
commands takes much time. A command imports `fetch.js` and the modules of the
other commands that it uses, not `mod.js`. The test `cmd/folders_test.js` makes
sure that the two lists are the same.

## Tests of a backend

Each backend must pass the shared tests of `@rfetch/lib/testing/suite`. These
tests are as the tests `fstests` of rclone, for the contract above. The file
"main_test.js" of the backend calls the suite one time:

```js
import { backendSuite } from "@rfetch/lib/testing/suite";
import backend from "./main.js";

backendSuite("remote", backend);
```

A backend with options gives them in `params`, which go in the query of each
request, for example
`backendSuite("alias", alias, { params: { remote:
":memory:" } })`.

The suite creates the folder `/rfetch-test-RANDOM/`, does all its tests in it,
and deletes it at the end. It tests:

- 404 for a file or a folder that does not exist, with `GET`, `HEAD` and
  `DELETE`.
- `PUT` of a folder, and of a file in folders that do not exist.
- The names of the test `FsEncoding` of rclone, for example names with a space
  at the start or at the end, `%`, `?`, `#`, `<`, `&` and Unicode.
- A file of 0 bytes, and a file of more than 64 KiB.
- The list of each folder: the name, the type, the size and the time of each
  file.
- `GET` and `HEAD` of a file: the bytes, and the headers.
- Ranges of a file: at the start, at the end, at the ends of blocks of 64 KiB,
  416, and ranges that the backend does not read.
- `PUT` over a file, `DELETE` of a file, and `DELETE` of a folder with all that
  is in it.

Other options are for some backends only:

- `skipName`: the suite skips the names that match this regular expression. Use
  it only for a limit that the backend has in rclone too. For example, rclone
  cannot read the name of a chunk with a line break.
- `writer`: for a read only backend, for example `http`, the `PUT` and `DELETE`
  requests go to this backend, and the backend under test reads the files.
- `parent`: the folder of the folder of the tests, `/` by default. For example,
  the tests of `s3` are in the bucket `/rfetch/`.
- `emptyFolders`: `false` for a backend that cannot have an empty folder, as
  `CanHaveEmptyDirectories` of rclone. For example, `s3` with no folder markers.
  Then the suite accepts 404 for a folder with no file.
- `type`: the type of the backend in rclone, for example `crypt`. With it, the
  suite also gives the `params` in the headers `RFETCH_TYPE_NAME` and in the
  variables `RCLONE_TYPE_NAME` of `env`, and makes sure that no link of a list
  has a query.

Put the tests for what only one backend does in the same file, after the suite.
For example, the tests of the local backend make sure that a path cannot go out
of the root folder.

Run all the tests with `npm test`, or the tests of one backend with
`npm test -w @rfetch/remote`.

Some tests compare rfetch with rclone, for example the tests of `lib/ini.js` and
the files `rclone_test.js` of the backends. They run when `rclone` is in the
`PATH`, or when the variable `RCLONE` is the path of rclone. Else they are
skipped. The tests of `backend/http/list.js` compare it with the `encoding/csv`
package of Go, when `go` is in the `PATH` or when the variable `GO` is its path.

The tests of `s3` use `rclone serve s3`, a server of the S3 API on a local
folder. They also run on a real service when the variables `S3_TEST_ENDPOINT`
and `S3_TEST_BUCKET` are set, with the region in `S3_TEST_REGION` (`auto` by
default). Put the credentials in `RFETCH_S3_ACCESS_KEY_ID` and
`RFETCH_S3_SECRET_ACCESS_KEY`, or in the variables of rclone with the prefix
`RCLONE_`. Use a bucket only for the tests: the tests make folders in it and
delete them.

## WebAssembly of crypt

The crypt backend encrypts the blocks of the data with
`backend/crypt/secretbox.wasm`: NaCl secretbox (XSalsa20 and Poly1305), as
rclone. Node.js, WebCrypto and Workers have no Salsa20, and the module is about
2 times faster than the same code in JavaScript. The module has no imports.

- The source is the Rust crate in `backend/crypt/native`.
  `backend/crypt/native/build.sh` builds the module, with the compiler of
  `rust-toolchain.toml` and the versions of `Cargo.lock`.
- XSalsa20 is in `src/salsa.rs`: it computes 4 blocks of Salsa20 at a time with
  the SIMD of WebAssembly. Poly1305 is the crate `poly1305`. `cargo test`
  compares each box with the crate `crypto_secretbox`, on the machine of the
  build, with the same code with no SIMD.
- Node.js, Deno and Bun read the file (`wasm.js`). A Worker cannot compile a
  module at run time, thus wrangler compiles it at the build
  (`wasm.workerd.js`). The field `imports` of `backend/crypt/package.json`
  selects the file.
- After a change of the crate, build the module and commit it with the change.
  The job `wasm` of CI builds the module again, and fails when its bytes are not
  the bytes of the file in the repository.

## Benchmarks

The cases of `bench/cases.js` measure the time of the backends, of the code in
`lib` and of the `fetch` of rfetch. The cases use only Web APIs, thus they run
in Node.js and in workerd, the runtime of Cloudflare Workers:

- `node bench/node.js` runs each case in a new process, as a command of rfetch
  does. The time of a case can change much with the work before it in the same
  process. `node bench/node.js NAME` runs only the case NAME.
- `npx wrangler dev -c bench/wrangler.json`, then `curl http://localhost:8787/`,
  runs all the cases in one request of a Worker. The clock of `wrangler dev`
  moves during the work of a request, thus the times are times of the CPU. The
  times of workerd change much from one run to the next: run it three times, and
  use the median.

- `node bench/rclone.js [RUNTIME...]` runs the same commands with rfetch and
  with rclone, which must be in the PATH or in the variable `RCLONE`: cat, rcat
  and `lsjson --recursive` on local files, crypt and chunker. Each RUNTIME is a
  program of Node.js, Deno or Bun that runs rfetch, for example
  `node bench/rclone.js node deno bun`. First it makes sure that each runtime
  gives the same data and the same lists as rclone. The time is the time of the
  whole process, with the start of the runtime or of rclone.

Measure before and after a change for speed, and write the two times in the
message of the commit.

## Continuous integration

The workflow `.github/workflows/ci.yml` runs for each push and each pull
request. It installs rclone and Go, runs `npm test` with Node.js 22, 24 and 26,
and runs `deno fmt --check`. Before a push, run `npm test` and
`deno fmt --check`.
