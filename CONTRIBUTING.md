# Contributing to rfetch

This is a short guide on how to contribute things to rfetch.

## Writing a new backend

Choose a name. The docs here will use `remote` as an example.

Note that in rfetch terminology a file system backend is called a remote or an
fs.

- Make the folder "backend/remote" with the files "main.js" and "main_test.js"
  for the new backend. The tests use the test runner of Node.js (`node:test`).
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
- `GET` of a file gives the headers `Content-Type`, `Content-Length` and
  `Last-Modified`.

The path of a request has percent-encoding. Use `decodePath` of `lib/path.js` to
get the path with no percent-encoding. It gives `null` for a path that is not
safe, for example `/..%2Fsecret.txt`, which becomes `/../secret.txt` after the
decoding. For `null`, give 400.

For displaying folder content, any HTML can be used, but the listing itself
should be in a `<table>`, whose each rows are for each file or folder inside.
Each items should have a `<a>` whose `href` attribute points to the file or
folder, and optionally a `type` attribute to tell the item's mime-type. A
`<data>` element should be used for file size, and `<time>` for file
modification time.

- The `href` is the name with percent-encoding (`encodeURIComponent`), with a
  `/` at the end for a folder.
- The text of the link is the name with `escapeHTML` of `lib/html.js`. Do not
  put a name in the HTML with no escape: a file with the name `<script>.txt`
  must not add a script to the page.
- `<data value>` is the size in bytes, for a file only.
- `<time datetime>` is the time in ISO 8601.

## Tests of a backend

Each backend must pass the shared tests of `lib/testing/suite.js`. These tests
are as the tests `fstests` of rclone, for the contract above. The file
"main_test.js" of the backend calls the suite one time:

```js
import { backendSuite } from "../../lib/testing/suite.js";
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
- `PUT` over a file, `DELETE` of a file, and `DELETE` of a folder with all that
  is in it.

Put the tests for what only one backend does in the same file, after the suite.
For example, the tests of the local backend make sure that a path cannot go out
of the root folder.

Run all the tests with `npm test`, or the tests of one backend with
`node --test backend/remote`.

Some tests compare rfetch with rclone, for example the tests of `lib/ini.js` and
`backend/crypt/rclone_test.js`. They run when `rclone` is in the `PATH`, or when
the variable `RCLONE` is the path of rclone. Else they are skipped.
