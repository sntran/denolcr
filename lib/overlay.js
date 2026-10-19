/**
 * The shared parts of a remote over the files of another remote, as the
 * archive remote of rclone: a file of a format, for example `files.zip`, is
 * a folder, and the other paths go to the other remote.
 *
 * As rclone, the remote can be in the path: `:archive:s3:bucket/files.zip/`
 * is the root of `files.zip` in the remote `s3:bucket`. A path in a file
 * needs a "/" after the name of the file: `files.zip` with no "/" is the
 * file of the remote.
 */
import { parse } from "./fspath.js";
import { readListing, renderListing } from "./listing.js";
import { encodePath } from "./path.js";

/**
 * Splits a path of rclone at its first file of a format.
 * @template T
 * @param {string} text A path of rclone, for example
 *   `s3:bucket/files.zip/folder/`.
 * @param {(name: string) => T | undefined} formatOf The format of a name,
 *   or undefined for a name of another file.
 * @returns {{ location: string, inner: string | null, format?: T }}
 *   `location` is the location for `fetch` of the file, or of the path
 *   when it has no file of a format. `inner` is the path in the file, ""
 *   for its root, with a "/" at the end for a folder. It is null for a path
 *   that is not in a file of a format.
 * @throws {SyntaxError} When the path is not correct.
 */
export function locate(text, formatOf) {
  const { name, configString, path } = parse(text);
  const head = name ? `${configString}:` : "";
  const names = path.split("/");
  // A file with a "/" after it: thus not the last name.
  for (let index = 0; index < names.length - 1; index++) {
    const format = names[index] ? formatOf(names[index]) : undefined;
    if (format) {
      return {
        location: head + encodePath(names.slice(0, index + 1).join("/")),
        inner: names.slice(index + 1).join("/"),
        format,
      };
    }
  }
  return { location: head + encodePath(path), inner: null };
}

/**
 * The path of rclone in the path of a request with no option `remote`. As
 * rclone, the path is the remote and its path, for example
 * `/s3:bucket/files.zip/` for `:archive:s3:bucket/files.zip/`. A path with
 * no remote is a local path, from the root.
 * @param {string} path
 */
export function pathOf(path) {
  const text = path.slice(1);
  try {
    if (text && parse(text).name) return text;
  } catch {
    // Not a remote: a local path.
  }
  return path;
}

/**
 * Sends a request for a path that is not in a file of a format to the
 * other remote. In the list of a folder, `folders` changes the entries,
 * for example to show each file of a format as a folder.
 * @param {Request} request
 * @param {string} location The location for `fetch` of the path.
 * @param {Headers} headers The headers for the other remote.
 * @param {(entries: import("./listing.js").Entry[]) =>
 *   import("./listing.js").Entry[]} folders
 * @returns {Promise<Response>}
 */
export async function passThrough(request, location, headers, folders) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);
  /** @type {RequestInit} */
  const init = { method, headers };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  const response = await fetch(location, init);
  if (!response.ok) return response;
  if (pathname.endsWith("/") && (method === "GET" || method === "HEAD")) {
    const answer = new Headers(response.headers);
    answer.delete("Content-Length");
    answer.set("Content-Type", "text/html;charset=utf-8");
    if (method === "HEAD") {
      await response.body?.cancel();
      return new Response(null, { status: response.status, headers: answer });
    }
    const entries = await readListing(
      response,
      new URL("http://remote/folder/"),
    );
    return new Response(
      renderListing(folders(entries), { query: `${searchParams}` }),
      { status: response.status, headers: answer },
    );
  }
  if (method === "PUT") {
    const answer = new Headers(response.headers);
    answer.set("Content-Location", pathname);
    return new Response(response.body, {
      status: response.status,
      headers: answer,
    });
  }
  return response;
}

/**
 * The headers of a request for a part of a file of a format: the headers
 * for the other remote, with no range and no body.
 * @param {Headers} headers
 */
export function partHeaders(headers) {
  const plain = new Headers(headers);
  for (const name of ["Range", "If-Range", "Content-Length", "Content-Type"]) {
    plain.delete(name);
  }
  return plain;
}
