import { auth } from "./auth.ts";
import { list } from "./list.ts";
import { create } from "./create.ts";

const FOLDER_TYPE = "application/vnd.google-apps.folder";

async function router(request: Request) {
  let response = await auth(request);
  if (!response.ok) {
    return response;
  }

  const {
    access_token,
    token_type,
  } = await response.json();

  // "Upgrade" request to authorized request.
  request = new Request(request, {
    headers: {
      "Authorization": `${token_type} ${access_token}`,
    },
  });

  const { method, url } = request;
  let { pathname, searchParams } = new URL(url);

  pathname = decodeURIComponent(pathname);
  const dirname = pathname.substring(0, pathname.lastIndexOf("/") + 1);
  const isDirectory = pathname.endsWith("/");

  const headers = new Headers();
  let status = 200, body = null;

  if (method === "HEAD" || method === "GET") {
    // Retrieves file or folder info.
    response = await list(request);
    const result = await response.json();
    if (result.error) {
      const { error, code, message } = result;
      return Response.json({
        error,
        code,
        message,
      }, {
        status: code,
        statusText: message,
      });
    }

    const files: Record<string, string>[] = result.files;

    // For request to folder, the file name list is returned in the Link header.
    if (isDirectory) {
      for await (let { name, mimeType } of files) {
        if (mimeType === FOLDER_TYPE) { // Folder
          name += "/";
        }
        headers.append("Link", `<${encodeURIComponent(name)}>`);
      }
    } else {
      const file = files.find((file) => {
        return file.mimeType !== FOLDER_TYPE &&
          file.name ===
            decodeURIComponent(pathname).slice(1).split("/").at(-1);
      })!;

      headers.append("Content-Type", file.mimeType);
      headers.append("Content-Length", file.size);
      headers.append("Last-Modified", file.modifiedTime);
      headers.append("ETag", file.md5Checksum);
    }
  }

  if (method === "GET") {
    // Retrieves file content.
    body = new ReadableStream();
  }

  if (method === "PUT") {
    // Folder ending with trailing slash.
    if (pathname.endsWith("/")) {
      request.headers.set("Content-Type", FOLDER_TYPE);
    }

    response = await create(request);

    status = response.status;
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
