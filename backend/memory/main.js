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
 * A file: its bytes, its media type, and the time of its last change.
 * @typedef {Object} File
 * @property {Uint8Array} bytes
 * @property {string} type
 * @property {number} modified In milliseconds.
 */

/**
 * The files, by their path with no percent-encoding.
 * @type {Map<string, File>}
 */
const files = new Map();

/**
 * The folders, by their path with no percent-encoding and with `/` at the
 * end. The value is the names of the children: `name` for a file and
 * `name/` for a folder. Thus a list reads only its folder.
 * @type {Map<string, Set<string>>}
 */
const folders = new Map([["/", new Set()]]);

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
    const file = files.get(path);
    if (file) {
      const { bytes } = file;
      headers.set("Content-Type", file.type || mimeType(path));
      headers.set("Content-Length", `${bytes.length}`);
      headers.set("Last-Modified", new Date(file.modified).toUTCString());
      headers.set("Accept-Ranges", "bytes");
      if (method === "GET") {
        let range;
        try {
          range = parseRange(request.headers.get("Range"), bytes.length);
        } catch {
          return notSatisfiable(bytes.length);
        }
        // The body is a copy of the bytes, with a length. A Worker reads a
        // Blob in chunks of 4 KiB, which is slow.
        body = bytes;
        if (range) {
          status = 206;
          for (
            const [name, value] of Object.entries(
              partialHeaders(range, bytes.length),
            )
          ) {
            headers.set(name, value);
          }
          body = bytes.subarray(range.start, range.end + 1);
        }
      }
    } else if (folders.has(path)) {
      headers.set("Content-Type", "text/html;charset=utf-8");
      if (method === "GET") {
        body = listing(path, searchParams);
      }
    } else {
      return new Response(null, { status: 404 });
    }
  } else if (method === "PUT") {
    const slash = path.lastIndexOf("/") + 1;
    // Creates the parent folders, then the folder or the file.
    makeFolder(path.slice(0, slash));
    if (slash < path.length) {
      const name = path.slice(slash);
      files.set(path, {
        bytes: new Uint8Array(await request.arrayBuffer()),
        type: request.headers.get("Content-Type") || mimeType(name),
        modified: Date.now(),
      });
      folders.get(path.slice(0, slash))?.add(name);
    }

    status = 201;
    headers.append("Content-Location", pathname);
  } else if (method === "DELETE") {
    if (files.has(path)) {
      files.delete(path);
      const slash = path.lastIndexOf("/") + 1;
      folders.get(path.slice(0, slash))?.delete(path.slice(slash));
    } else if (folders.has(path)) {
      // Deletes the folder and all in it. The root folder stays.
      removeFolder(path);
      if (path === "/") {
        folders.set("/", new Set());
      } else {
        const parent = path.slice(
          0,
          path.lastIndexOf("/", path.length - 2) + 1,
        );
        folders.get(parent)?.delete(path.slice(parent.length));
      }
    } else {
      return new Response(null, { status: 404 });
    }
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
 * Creates a folder and its parent folders.
 * @param {string} path The path of the folder, with `/` at the end.
 */
function makeFolder(path) {
  if (folders.has(path)) return;
  const parent = path.slice(0, path.lastIndexOf("/", path.length - 2) + 1);
  makeFolder(parent);
  folders.set(path, new Set());
  folders.get(parent)?.add(path.slice(parent.length));
}

/**
 * Removes a folder, its files and its folders.
 * @param {string} path The path of the folder, with `/` at the end.
 */
function removeFolder(path) {
  for (const name of folders.get(path) ?? []) {
    if (name.endsWith("/")) removeFolder(`${path}${name}`);
    else files.delete(`${path}${name}`);
  }
  folders.delete(path);
}

/**
 * Gives the HTML list of the files and the folders in a folder.
 * @param {string} path The path of the folder, with `/` at the end.
 * @param {URLSearchParams} searchParams The query, for each link.
 * @returns {ReadableStream<Uint8Array>}
 */
function listing(path, searchParams) {
  /** @type {import("@rfetch/lib/listing").Entry[]} */
  const entries = [];
  for (const child of folders.get(path) ?? []) {
    if (child.endsWith("/")) {
      entries.push({
        Name: child.slice(0, -1),
        IsDir: true,
        Size: -1,
        MimeType: "",
        ModTime: "",
      });
    } else {
      const file = files.get(`${path}${child}`);
      if (!file) continue;
      entries.push({
        Name: child,
        IsDir: false,
        Size: file.bytes.length,
        MimeType: file.type || mimeType(child),
        ModTime: new Date(file.modified).toISOString(),
      });
    }
  }
  return renderListing(entries, { query: `${searchParams}` });
}

export default {
  fetch: memory,
};
