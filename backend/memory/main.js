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
import { modTimeOf } from "@rfetch/lib/time";

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
 * Serves a memory remote.
 *
 * Other than GET, HEAD, PUT and DELETE, it knows:
 *
 * - `COPY` of a file, and `MOVE` of a file or a folder, to the path of the
 *   header `Destination` in this remote. A folder moves only to a path that
 *   does not exist.
 * - `PATCH` of a file with the header `X-OC-Mtime`: it sets the time of the
 *   file.
 *
 * A `PUT`, a `COPY` or a `MOVE` with `X-OC-Mtime` gives that time to the
 * file, and its answer has `X-OC-Mtime: accepted`.
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

  const modTime = modTimeOf(request);
  if (modTime === undefined) {
    return new Response("X-OC-Mtime is not a time", { status: 400 });
  }
  /** The time of the request, in milliseconds. */
  const modified = modTime === null ? undefined : Number(modTime / 1000000n);

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
        modified: modified ?? Date.now(),
      });
      folders.get(path.slice(0, slash))?.add(name);
      if (modified !== undefined) headers.set("X-OC-Mtime", "accepted");
    }

    status = 201;
    headers.append("Content-Location", pathname);
  } else if (method === "DELETE") {
    if (files.has(path)) {
      removeFile(path);
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
  } else if (method === "COPY" || method === "MOVE") {
    const target = decodePath(request.headers.get("Destination") ?? "");
    if (target === null) {
      return new Response("Destination is not a path", { status: 400 });
    }
    return transfer(method, path, target, modified, headers);
  } else if (method === "PATCH") {
    const file = files.get(path);
    if (!file) return new Response(null, { status: 404 });
    if (modified === undefined) {
      return new Response("X-OC-Mtime is missing", { status: 400 });
    }
    file.modified = modified;
    headers.set("X-OC-Mtime", "accepted");
    status = 204;
  } else {
    status = 405;
    headers.set("Allow", ALLOW);
  }

  return new Response(body, {
    status,
    headers,
  });
}

/** The methods of the backend. */
const ALLOW = "GET, HEAD, PUT, DELETE, COPY, MOVE, PATCH";

/**
 * Copies or moves a file, or moves a folder.
 * @param {"COPY" | "MOVE"} method
 * @param {string} path The source, with no percent-encoding.
 * @param {string} target The destination, with no percent-encoding.
 * @param {number | undefined} modified The time of the copy, in
 *   milliseconds, or the time of the source.
 * @param {Headers} headers The headers of the answer.
 * @returns {Response}
 */
function transfer(method, path, target, modified, headers) {
  const file = files.get(path);
  if (file) {
    if (target.endsWith("/") || folders.has(`${target}/`)) {
      return new Response("Destination is a folder", { status: 409 });
    }
    const existed = files.has(target);
    if (target !== path) {
      const slash = target.lastIndexOf("/") + 1;
      makeFolder(target.slice(0, slash));
      files.set(target, {
        // A body of a GET is the bytes of the file: the copy has its own
        // bytes.
        bytes: method === "COPY" ? file.bytes.slice() : file.bytes,
        type: file.type,
        modified: modified ?? file.modified,
      });
      folders.get(target.slice(0, slash))?.add(target.slice(slash));
      if (method === "MOVE") removeFile(path);
    } else if (modified !== undefined) {
      file.modified = modified;
    }
    if (modified !== undefined) headers.set("X-OC-Mtime", "accepted");
    return new Response(null, { status: existed ? 204 : 201, headers });
  }
  if (!path.endsWith("/") || !folders.has(path)) {
    return new Response(null, { status: 404 });
  }
  // A folder moves to a new path, out of the folder.
  if (method === "COPY") {
    return new Response("COPY of a folder is not implemented", {
      status: 501,
    });
  }
  if (path === "/") return new Response(null, { status: 403 });
  if (!target.endsWith("/") || target.startsWith(path)) {
    return new Response("Destination is not a new folder", { status: 400 });
  }
  if (folders.has(target) || files.has(target.slice(0, -1))) {
    return new Response("Destination exists", { status: 412 });
  }
  const parent = target.slice(
    0,
    target.lastIndexOf("/", target.length - 2) + 1,
  );
  makeFolder(parent);
  for (const [key, value] of [...folders]) {
    if (!key.startsWith(path)) continue;
    folders.delete(key);
    folders.set(`${target}${key.slice(path.length)}`, value);
  }
  for (const [key, value] of [...files]) {
    if (!key.startsWith(path)) continue;
    files.delete(key);
    files.set(`${target}${key.slice(path.length)}`, value);
  }
  const from = path.slice(0, path.lastIndexOf("/", path.length - 2) + 1);
  folders.get(from)?.delete(path.slice(from.length));
  folders.get(parent)?.add(target.slice(parent.length));
  return new Response(null, { status: 201, headers });
}

/**
 * Removes a file from its folder.
 * @param {string} path
 */
function removeFile(path) {
  files.delete(path);
  const slash = path.lastIndexOf("/") + 1;
  folders.get(path.slice(0, slash))?.delete(path.slice(slash));
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
