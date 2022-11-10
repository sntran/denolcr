import { contentType, extname } from "../../deps.ts";

/** Main export */
async function router(request: Request): Promise<Response> {
  const { method, url } = request;
  const { pathname } = new URL(url);

  let stats;

  const headers = new Headers();
  let status = 200, body = null;

  if (method === "HEAD" || method === "GET") {
    const file = await Deno.open(pathname);
    stats = await file.stat();
    file.close();

    if (stats.isDirectory) {
      for await (let { name, isDirectory } of Deno.readDir(pathname)) {
        if (isDirectory) {
          name += "/";
        }
        headers.append("Link", `<${encodeURIComponent(name)}>`);
      }
    } else {
      headers.append("Content-Type", contentType(extname(pathname)) || "");
      headers.append("Content-Length", stats.size.toString());
    }

    const mtime = stats.mtime?.toUTCString();
    if (mtime) headers.append("Last-Modified", mtime);
  }

  if (method === "GET") {
    if (stats?.isFile) {
      const file = await Deno.open(pathname);
      body = file.readable;
    }

    /** @TODO: What's about folder? */
  }

  /** `PUT` upserts a file at `pathname`. */
  if (method === "PUT") {
    // Folder ending with trailing slash.
    if (pathname.endsWith("/")) {
      await Deno.mkdir(pathname, { recursive: true });
    } else {
      const file = await Deno.open(pathname, { write: true, create: true });
      await request.body!.pipeTo(file.writable);
    }

    status = 201;
    headers.append("Content-Location", pathname);
  }

  if (method === "DELETE") {
    await Deno.remove(pathname, { recursive: true });
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
