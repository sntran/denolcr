# Contributing to rclone

This is a short guide on how to contribute things to rclone.

## Writing a new backend

Choose a name. The docs here will use `remote` as an example.

Note that in rclone terminology a file system backend is called a remote or an
fs.

- `deno init backend/remote`
- Edit "backend/remote/main.ts" and "backend/remote/main_test.ts" for the new
  backend.
- Implements a `fetch` export function that handles "HEAD", "GET", "PUT" and
  "DELETE".
- Uses `backend/local/main.ts` as reference, or the boilerplate below:

```ts
import {} from "../../deps.ts";

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
}

const exports = {
  fetch: router,
};

export {
  // For Cloudflare Workers.
  exports as default,
  router as fetch,
};

// Learn more at https://deno.land/manual/examples/module_metadata#concepts
if (import.meta.main) {
  Deno.serve(router);
}
```
