# Contributing to rfetch

This is a short guide on how to contribute things to rfetch.

## Writing a new backend

Choose a name. The docs here will use `remote` as an example.

Note that in rfetch terminology a file system backend is called a remote or an
fs.

- `deno init backend/remote`
- Edit "backend/remote/main.js" and "backend/remote/main_test.js" for the new
  backend.
- Implements a `fetch` default export function that handles "GET", "PUT" and
  "DELETE".
- Uses `backend/local/main.js` as reference, or the boilerplate below:

```ts
import {} from "../../deps.js";

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
- `PUT /folder/`: creates folder.
- `PUT /file`: uploads file.
- `DELETE /folder/`: deletes folder.
- `DELETE /file`: deletes file.

For displaying folder content, any HTML can be used, but the listing itself
should be in a `<table>`, whose each rows are for each file or folder inside.
Each items should have a `<a>` whose `href` attribute points to the file or
folder, and optionally a `type` attribute to tell the item's mime-type. A
`<data>` element should be used for file size, and `<time>` for file
modification time.
