/**
 * Memory Backend
 *
 * The memory backend is an in RAM backend. It does not persist its data - use
 * the local backend for that.
 *
 * Because it has no parameters you can just use it with the `:memory:` remote
 * name.
 */
import {} from "../../deps.ts";

const cache: Map<string, ReadableStream | null> = new Map();

function router(request: Request): Response {
  const { method, url } = request;
  const { pathname } = new URL(url);

  const headers = new Headers();
  let status = 200, body = null;

  if (method === "HEAD" || method === "GET") {
    const regex = new RegExp(pathname + "([^/]+/?)");
    // Retrieves file or folder info.
    const links: string[] = [];
    for (const key of cache.keys()) {
      const [, child] = key.match(regex) || [];
      if (child) {
        const link = `<${encodeURIComponent(child)}>`;
        if (!links.includes(link)) {
          links.push(link);
          headers.append("Link", link);
        }
      }
    }
  }

  if (method === "GET") {
    // Retrieves file content.
    for (const [key, value] of cache) {
      if (key === pathname) {
        body = value;
        break;
      }
    }

    if (!body) {
      status = 404;
    }
  }

  if (method === "PUT") {
    // Folder ending with trailing slash.
    if (pathname.endsWith("/")) {
      // Creates folder.
      cache.set(pathname, null);
    } else {
      // Creates file.
      cache.set(pathname, request.body);
    }

    status = 201;
    headers.append("Content-Location", pathname);
  }

  if (method === "DELETE") {
    // Folder ending with trailing slash.
    if (pathname.endsWith("/")) {
      // Deletes files in that folder.
      for (const key of cache.keys()) {
        if (key.startsWith(pathname)) {
          cache.delete(key);
        }
      }
      // Deletes the folder itself
      cache.delete(pathname);
    } else {
      // Deletes file.
      cache.delete(pathname);
    }
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
