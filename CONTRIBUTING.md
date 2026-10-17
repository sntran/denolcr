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
such a path: the import of `mod.js` sets it, and `_worker.js` imports `mod.js`.
The tests of such a backend import `mod.js` too:

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
default). Put the credentials in `RCLONE_S3_ACCESS_KEY_ID` and
`RCLONE_S3_SECRET_ACCESS_KEY`. Use a bucket only for the tests: the tests make
folders in it and delete them.

## Continuous integration

The workflow `.github/workflows/ci.yml` runs for each push and each pull
request. It installs rclone and Go, runs `npm test` with Node.js 22, 24 and 26,
and runs `deno fmt --check`. Before a push, run `npm test` and
`deno fmt --check`.
