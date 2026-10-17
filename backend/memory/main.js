/**
 * Memory Backend
 *
 * The memory backend is an in RAM backend. It does not persist its data - use
 * the local backend for that.
 *
 * Because it has no parameters you can just use it with the `:memory:` remote
 * name.
 */
import { renderListing } from "@rfetch/lib/listing";
import { mimeType } from "@rfetch/lib/mime";
import { decodePath } from "@rfetch/lib/path";
import { notSatisfiable, parseRange, partialHeaders } from "@rfetch/lib/range";

/**
 * The files and the folders, by their path with no percent-encoding. The path
 * of a folder ends with `/`, and a folder has no value.
 * @type {Map<string, File | null>}
 */
const cache = new Map();
// Creates the root folder.
cache.set("/", null);

/**
 * Serves a memory remote
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function memory(request) {
  const { method, url } = request;
  const { pathname, searchParams } = new URL(url);
  const path = decodePath(pathname);

  if (path === null) {
    return new Response(null, { status: 400 });
  }

  const headers = new Headers();
  let status = 200, body = null;

  if (method === "HEAD" || method === "GET") {
    if (!cache.has(path)) {
      return new Response(null, { status: 404 });
    }

    const file = cache.get(path);
    if (file) {
      headers.set("Content-Type", file.type || mimeType(path));
      headers.set("Content-Length", `${file.size}`);
      headers.set("Last-Modified", new Date(file.lastModified).toUTCString());
      headers.set("Accept-Ranges", "bytes");
      // A Blob has a size, thus a Worker sends its Content-Length.
      if (method === "GET") {
        let range;
        try {
          range = parseRange(request.headers.get("Range"), file.size);
        } catch {
          return notSatisfiable(file.size);
        }
        body = file;
        if (range) {
          status = 206;
          for (
            const [name, value] of Object.entries(
              partialHeaders(range, file.size),
            )
          ) {
            headers.set(name, value);
          }
          body = file.slice(range.start, range.end + 1);
        }
      }
    } else {
      headers.set("Content-Type", "text/html;charset=utf-8");
      if (method === "GET") {
        body = listing(path, searchParams);
      }
    }
  } else if (method === "PUT") {
    // Creates the parent folders, then the folder or the file.
    const names = path.split("/").slice(1, -1);
    let folder = "/";
    for (const name of names) {
      folder += `${name}/`;
      cache.set(folder, null);
    }

    if (!path.endsWith("/")) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      const file = new File([await request.arrayBuffer()], name, {
        type: request.headers.get("Content-Type") || mimeType(name),
        lastModified: Date.now(),
      });
      cache.set(path, file);
    }

    status = 201;
    headers.append("Content-Location", pathname);
  } else if (method === "DELETE") {
    if (!cache.has(path)) {
      return new Response(null, { status: 404 });
    }

    // Deletes the file, or the folder and all in it.
    for (const key of cache.keys()) {
      if (key === path || (path.endsWith("/") && key.startsWith(path))) {
        cache.delete(key);
      }
    }
    // The root folder stays.
    cache.set("/", null);
    status = 204;
  } else {
    status = 405;
    headers.set("Allow", "GET, HEAD, PUT, DELETE");
  }

  return new Response(body, {
    status,
    headers,
  });
}

/**
 * Gives the HTML list of the files and the folders in a folder.
 * @param {string} path The path of the folder, with `/` at the end.
 * @param {URLSearchParams} searchParams The query, for each link.
 * @returns {ReadableStream<Uint8Array>}
 */
function listing(path, searchParams) {
  // The children are the paths in the folder with no other "/" than a "/" at
  // the end for a folder.
  /** @type {import("@rfetch/lib/listing").Entry[]} */
  const entries = [];
  for (const [key, file] of cache) {
    if (key === path || !key.startsWith(path)) continue;
    const child = key.slice(path.length);
    const slash = child.indexOf("/");
    if (slash === -1) {
      entries.push({
        Name: child,
        IsDir: false,
        Size: file.size,
        MimeType: file.type || mimeType(child),
        ModTime: new Date(file.lastModified).toISOString(),
      });
    } else if (slash === child.length - 1) {
      entries.push({
        Name: child.slice(0, -1),
        IsDir: true,
        Size: -1,
        MimeType: "",
        ModTime: "",
      });
    }
  }
  return renderListing(entries, { query: `${searchParams}` });
}

export default {
  fetch: memory,
};
