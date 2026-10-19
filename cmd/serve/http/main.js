import { relink } from "@rfetch/lib/listing";
import { isOption } from "@rfetch/lib/options";
import { decodePath } from "@rfetch/lib/path";

import { fetch } from "../../../fetch.js";
import { listen } from "../listen.js";

/** The methods of a client, as `rclone serve http`: it only reads. */
const METHODS = ["GET", "HEAD"];

/**
 * Serves a folder of a remote over HTTP, as `rclone serve http`. The path of
 * a request is a path in the folder. Each request goes to the fetch of
 * rfetch, thus the remote gets all its options: the config file, the
 * variables of the environment, and the flags of the backend, for example
 * `--crypt-password`.
 *
 * A client sets no option of the remote: its query and its headers
 * `RFETCH_*` and `RCLONE_*` go away. Else a client could change the remote,
 * for example `?remote=/etc/` for alias, or tell a new remote in the headers.
 * @param {string} remote The remote and the path of the folder, for example
 *   `remote:path/to/folder`.
 * @param {Object} [flags] `addr`, and the flags of the backend.
 * @returns {Response} The lines of the server, for example the address.
 */
export function serve(remote, flags = {}) {
  const {
    addr = "127.0.0.1:8080",
    ...backendFlags
  } = flags;

  // The path of each request goes after the folder.
  const folder = /[:/]$/.test(remote) ? remote : `${remote}/`;
  const query = `${new URLSearchParams(backendFlags)}`;

  return listen(addr, METHODS, async (request) => {
    const { pathname } = new URL(request.url);
    // The URL parser removes the names `.` and `..`, but a name such as
    // `..%2F..%2Fetc` must not go out of the folder.
    if (decodePath(pathname) === null) {
      return new Response("Bad Request", { status: 400 });
    }
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!isOption(name)) headers.append(name, value);
    }
    const path = `${folder}${pathname.slice(1)}`;
    const response = await fetch(query ? `${path}?${query}` : path, {
      method: request.method,
      headers,
      signal: request.signal,
    });
    // The links of a list have the options of the backend in their query.
    // The server reads no query, thus the links of its lists have none.
    const type = response.headers.get("Content-Type") || "";
    if (response.ok && pathname.endsWith("/") && type.startsWith("text/html")) {
      return relink(response, "");
    }
    return response;
  });
}
