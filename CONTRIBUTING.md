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

The module of a backend exports its options with their types, for example
`export const options = { boolean: ["no_head"], string: ["url"] }`. An option in
`default` and in no list is a `string`. The command line makes a flag of each
option, for example `--http-no-head` and `--http-url URL`. An option that is not
in `options` has no flag: its flag is an unknown flag.

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
query cannot set it. Thus `:local:path` stays in the current folder.

`rfetch serve http REMOTE:PATH` serves the folder `REMOTE:PATH`, as
`rclone serve http`: the path of a request is a path in that folder, and each
request goes to the `fetch` of `fetch.js`. Thus the remote gets all its options,
from the config file, the variables and the flags. A client only reads: the
server refuses each method but `GET` and `HEAD`, and `TRACE` most of all,
because the answer of `fetch.js` to `TRACE` tells the options of the remote. A
client sets no option: the server removes its query and its headers `RFETCH_*`
and `RCLONE_*`, and a name with a `/` after the decoding gives 400.

`rfetch serve webdav REMOTE:PATH` serves the folder `REMOTE:PATH` over WebDAV,
as `rclone serve webdav`, with the same rules for the options of the remote. The
code of WebDAV is in `cmd/serve/webdav/handler.js`, and the Worker uses it too:

- PROPFIND reads the headers of HEAD, and the list of a folder for `Depth: 1`.
  `Depth: infinity` gets 403, as RFC 4918 permits.
- MKCOL is PUT of a folder. COPY and MOVE of a file, and MOVE of a folder to a
  path that does not exist, go to the backend. For a backend that cannot do it,
  or a destination in another remote, the server reads each file from the source
  and puts it at the destination, and MOVE deletes the source after.
- A PUT, a COPY or a MOVE of a file with `X-OC-Mtime` gives that time to the
  file, with `X-OC-Mtime: accepted` in the answer when the backend keeps it.
  `rclone serve webdav` gives the time of a COPY to the source: rfetch gives it
  to the destination, as ownCloud. A PROPPATCH of `lastmodified` with the
  seconds after 1970 is a PATCH of the backend, as ownCloud.
- The server keeps no data between requests: LOCK gives a token and locks
  nothing, and PROPPATCH keeps no other property, as `rclone serve webdav`. The
  clients of Windows and macOS need LOCK to write.
- A client writes, unless `--read-only`. With `--user` and `--pass`, a client
  must give them with the Basic authentication. The default address is
  `127.0.0.1:8080`.

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
`backend/s3/sigv4.js`.

## Architecture

- `GET /folder/`: displays HTML page with folder content.
- `GET /file`: fetches file.
- `HEAD /folder/` and `HEAD /file`: the same headers as `GET`, with no body.
- `PUT /folder/`: creates folder.
- `PUT /file`: uploads file. `PUT` creates the parent folders that do not exist.
- `DELETE /folder/`: deletes folder, and all the files and folders in it.
- `DELETE /file`: deletes file.

A backend can also know these methods, as the features `Copy`, `Move`, `DirMove`
and `SetModTime` of rclone:

- `COPY /file` with `Destination: /path`: copies the file in the backend, and
  the bytes do not go through rfetch. The destination is a path in the same
  root, with percent-encoding, as the path of a request. A file at the
  destination is replaced, and the folders of the destination are made, as `PUT`
  does.
- `MOVE /file` with `Destination: /path`: moves the file, with the same rules.
- `MOVE /folder/` with `Destination: /path/`: moves the folder with all that is
  in it, to a path that does not exist. A destination that exists gives 412.
- `PATCH /file` with `X-OC-Mtime`: sets the time of the file.

The header `X-OC-Mtime` of ownCloud is the time of a file, in seconds after
1970, with an optional part of a second, for example `1354040105.123456789`. A
`PUT`, a `COPY` or a `MOVE` of a file with it gives that time to the file, and
the answer of a backend that keeps it has `X-OC-Mtime: accepted`. Then `GET`,
`HEAD` and the list give that time. Read it with `modTimeOf` of
`@rfetch/lib/time`. s3 keeps the time in the metadata of the file, as rclone:
its list gives the time of the upload, because a list of S3 has no metadata.

A backend that does not know a method gives 405. A backend that cannot do a
`COPY` or a `MOVE`, for example a `COPY` of a folder, gives 501. Then a command
reads the source and puts it at the destination.

`fetch.js` gives the backend the path of the destination in its root, from the
location of the destination, for example `remote:path/b.txt`. The two locations
must have the same type, the same query and the same options: else `fetch.js`
gives 502, as WebDAV gives for a destination on another server, and the backend
gets no request. Thus a `Destination` never takes a backend out of its remote. A
backend on another remote, for example alias and crypt, gives the location of
the destination in that remote to `fetch`, as it does for the path of the
request. A backend that cannot give that location, for example the files in an
archive, gives 405 to a `COPY` and a `MOVE`: it must not send the `Destination`
of its client to another remote.

The answers:

- `PUT` gives 201 with the path in `Content-Location`. `DELETE` gives 204.
- `COPY` and `MOVE` give 201 for a new file, or 204 when the destination was a
  file. `PATCH` gives 204.
- A file or a folder that does not exist gives 404.
- `GET` of a file gives the headers `Content-Type`, `Content-Length`,
  `Last-Modified` and `Accept-Ranges: bytes`.
- `GET` with `Range: bytes=START-END` gives 206 with the bytes of the range,
  `Content-Range` and the `Content-Length` of the range, as RFC 9110. A range
  with no byte of the file gives 416. A request with more ranges, or with a
  range that is not correct, gets all the file. Use `parseRange` of
  `@rfetch/lib/range`.

A backend that reads parts of a file of another remote, for example the index at
the end of a zip file, uses `RangedFile` of `@rfetch/lib/ranged`: each read is
one request with `Range`, and the file never comes all into memory.

The path of a request has percent-encoding. Use `decodePath` of
`@rfetch/lib/path` to get the path with no percent-encoding. It gives `null` for
a path that is not safe, for example `/..%2Fsecret.txt`, which becomes
`/../secret.txt` after the decoding. For `null`, give 400. A backend that reads
a remote in its path, as `:archive:s3:bucket/a.zip`, uses `decodeRemotePath`:
the connection string of that remote can have empty names, for example in
`url='https://example.com'`.

A service can refuse some names, or change them, for example a name with a
control character or with a dot at the end. As rclone, a backend for such a
service changes these names with the option `encoding`: read its value with
`parseEncoding` of `@rfetch/lib/encoder`, give each name of a request to
`encodeName`, and each name of a list to `decodeName`. The default value is the
default of rclone for that backend: then rclone and rfetch keep the same names
in the service.

A backend that uploads a large file in parts, for example s3 and azureblob,
reads the body with `Parts` of `@rfetch/lib/parts`: each part has the size of
the option `chunk_size`, and only one part is in memory.

A backend on another remote, for example alias, gives `fetch` the location
`encodeLocation(remote) + encodePath(path)`. The option `remote` is a path of
rclone: `encodeLocation` of `@rfetch/lib/fspath` keeps its `%`, `?` and `#` in
the names.

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

`parseFlags` of `cmd/flags.js` reads the flags of the command line, as rclone.
Each flag has a type: a flag of type `boolean` takes no value, or a value after
`=`, for example `--dir-slash=false`. A flag of type `string` takes the next
argument, for example `--max-depth 2`, or a value after `=`. The `parseArgs` of
Node.js knows the type only of the flags that it gets: it reads an unknown flag
as a `boolean`, and the value of the flag as an argument of the command. Thus a
new flag of a command goes in `FLAGS` of `cmd/flags.js`, and a new option of a
backend goes in its `options`. An unknown flag is an error, as in rclone. A
command reads a boolean flag with `isTrue` of `@rfetch/lib/options`: the flag
can be `true` or the text `true` of a query.

The lists of text, `ls`, `lsl`, `lsd` and `lsf`, send the body of `lsjson`
through a `LineStream` of `cmd/lsjson/main.js`. This stream reads the body in
chunks of any size, and gives the line of each item. Each command writes the
line as rclone writes it: the time with `toListTime` of `@rfetch/lib/time`, in
the local time zone, and the size and the count with `sizeField` and
`countField` of `@rfetch/lib/format`, in fields of the widths of rclone.
`cmd/lsf/rclone_test.js` compares the lines with the lines of rclone.

The other commands use the operations of `cmd/operations.js`, as the package
`operations` of rclone: `stat` gives the information of a path, `walk` gives the
files and the folders in a folder, and `copyFile`, `moveFolder`, `setModTime`,
`remove` and `mkdir` change the files. `copyFile` sends a `COPY` or a `MOVE` to
the backend first, with the time of the source in `X-OC-Mtime`. For 403, 405,
501 and 502, it reads the source and puts it at the destination, with the same
time. An operation that fails throws an `OperationError` with the status of the
answer, and `failure` gives the answer of the command for it. `log` writes the
errors and the notices of rclone on the standard error, for example
`2006/01/02 15:04:05 ERROR : a.txt: sizes differ`, and `--quiet` keeps only the
errors. A command that has an output and an error, for example
`check --combined -`, gives the output in the body and the error in
`statusText`: the command line writes the body on the standard output, and the
error on the standard error.

The command line gives the exit codes of rclone: 3 for the status 404, 4 for the
status 404 with a message that ends with `object not found`, and 1 for another
status that is not 2xx.

`cmd/rclone_test.js` runs each command with rfetch and with rclone on the same
local folders, and compares the outputs, the exit codes and the files after the
command.

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
- `COPY`, `MOVE`, `PATCH` and `X-OC-Mtime`, as its `features` tell. A backend
  with no such feature must give 405, 403, 501 or 502, and must not change a
  file.

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
- `features`: what the backend can do other than `GET`, `HEAD`, `PUT` and
  `DELETE`: `copy`, `move` and `dirMove` for `COPY` of a file, `MOVE` of a file
  and `MOVE` of a folder, `modTime` for `X-OC-Mtime` on `PUT`, `copyModTime` for
  `X-OC-Mtime` on `COPY` and `MOVE` (by default the value of `modTime`),
  `setModTime` for `PATCH`, and `listModTime` for the time of `X-OC-Mtime` in
  the list (by default the value of `modTime`).

Put the tests for what only one backend does in the same file, after the suite.
For example, the tests of the local backend make sure that a path cannot go out
of the root folder.

Run all the tests with `npm test`, or the tests of one backend with
`npm test -w @rfetch/remote`.

Some tests compare rfetch with rclone, for example the tests of `lib/ini.js` and
the files `rclone_test.js` of the backends. They run when `rclone` is in the
`PATH`, or when the variable `RCLONE` is the path of rclone. Else they are
skipped. The tests of `lib/list.js` compare it with the `encoding/csv` package
of Go, when `go` is in the `PATH` or when the variable `GO` is its path. The
tests of `backend/archive/sevenzip_test.js` compare the archive backend with
7-Zip, when `7zz` is in the `PATH` or when the variable `SEVENZIP` is its path.
The tests of `backend/tiles/go_pmtiles_test.js` compare the tiles backend with
go-pmtiles, when `go-pmtiles` is in the `PATH` or when the variable `PMTILES` is
its path: `go install github.com/protomaps/go-pmtiles@v1.31.2`. They also need
`node:sqlite`, of Node.js 22.13 or later. The tests of
`backend/tiles/versatiles_rs_test.js` compare the tiles backend with versatiles
4.15.0, the tool of VersaTiles, when `versatiles` is in the `PATH` or when the
variable `VERSATILES` is its path. Get it from the
[releases of versatiles-rs](https://github.com/versatiles-org/versatiles-rs/releases/tag/v4.15.0),
or with `cargo install versatiles --version 4.15.0 --locked`. The tests of zstd
need Node.js 22.15 or later.

The tests of `webdav` use `rclone serve webdav`, and the tests in
`cmd/serve/webdav/rclone_test.js` use the webdav backend of rclone as a client
of `rfetch serve webdav`. The tests in `cmd/serve/webdav/main_test.js` use the
webdav backend of rfetch as a client of `rfetch serve webdav`, with no rclone.

The tests of `s3` use `rclone serve s3`, a server of the S3 API on a local
folder. They also run on a real service when the variables `S3_TEST_ENDPOINT`
and `S3_TEST_BUCKET` are set, with the region in `S3_TEST_REGION` (`auto` by
default). Put the credentials in `RFETCH_S3_ACCESS_KEY_ID` and
`RFETCH_S3_SECRET_ACCESS_KEY`, or in the variables of rclone with the prefix
`RCLONE_`. Use a bucket only for the tests: the tests make folders in it and
delete them.

The tests of `azureblob` use Azurite, the emulator of Azure Storage, with its
data in memory: they run when `azurite-blob` is in the `PATH`, or when the
variable `AZURITE` is its path. Get it with `npm install azurite@3.37.0`. The
tests with rclone use the same Azurite. The tests of `doi` use a local server
that gives the answers of Zenodo, InvenioRDM and Dataverse: they need no
network.

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
request. It installs rclone, 7-Zip, Go, go-pmtiles, versatiles and Azurite, runs
`npm test` with Node.js 22, 24 and 26, and runs `deno fmt --check`. A test that
needs one of these tools skips when the tool is not installed: in the workflow,
such a skip is an error. Before a push, run `npm test` and `deno fmt --check`.
