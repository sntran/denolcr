/**
 * Memory Backend
 *
 * The memory backend is an in RAM backend. It does not persist its data - use
 * the local backend for that.
 *
 * Because it has no parameters you can just use it with the `:memory:` remote
 * name.
 */
import { formatBytes } from "../../lib/format.js";
import { escapeHTML } from "../../lib/html.js";
import { mimeType } from "../../lib/mime.js";
import { decodePath } from "../../lib/path.js";

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
      if (method === "GET") {
        body = file.stream();
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
  /** @type {string[]} */
  const children = [];
  for (const key of cache.keys()) {
    if (key === path || !key.startsWith(path)) continue;
    const child = key.slice(path.length);
    const slash = child.indexOf("/");
    if (slash === -1 || slash === child.length - 1) {
      children.push(child);
    }
  }
  children.sort((a, b) => a.localeCompare(b));

  const query = escapeHTML(`${searchParams}`);

  return new ReadableStream({
    start(controller) {
      controller.enqueue(`
        <table cellpadding="4">
        <thead>
          <tr>
            <th></th>
            <th>Name</th>
            <th>Size</th>
            <th>Modified</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>📁</td>
            <td><a href="../?${query}">Go up</a></td>
            <td>—</td>
            <td>—</td>
          </tr>
      `);

      for (const child of children) {
        const file = cache.get(path + child);
        const isDirectory = file === null;
        const name = isDirectory ? child.slice(0, -1) : child;
        const href = `${encodeURIComponent(name)}${isDirectory ? "/" : ""}`;
        const type = isDirectory ? "" : file.type || mimeType(name);
        const lastModified = isDirectory ? null : new Date(file.lastModified);

        controller.enqueue(`<tr>
          <td>${isDirectory ? "📁" : "📄"}</td>
          <td>
            <a
              href="${href}?${query}"
              type="${escapeHTML(type)}"
            >${escapeHTML(child)}</a>
          </td>
          <td>${
          isDirectory ? "—" : `<data
              value="${file.size}"
            >${formatBytes(file.size, { locale: true })}</data>`
        }
          </td>
          <td>${
          lastModified
            ? `<time
                datetime="${lastModified.toISOString()}"
              >${lastModified.toLocaleString()}</time>`
            : "-"
        }
          </td>
        </tr>`);
      }

      controller.enqueue("</tbody></table>");
      controller.close();
    },
  }).pipeThrough(new TextEncoderStream());
}

export default {
  fetch: memory,
};
