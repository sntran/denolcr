/**
 * Alias remote
 *
 * The `alias` remote provides a new name for another remote.
 *
 * Paths may be as deep as required or a local path,
 * e.g. `remote:directory/subdirectory` or `/directory/subdirectory`.
 *
 * The target remote can either be a local path or another remote.
 *
 * Subfolders can be used in target remote. Assume an alias remote named
 * `backup` with the target `mydrive:private/backup`. Invoking
 * `rfetch mkdir backup:desktop` is exactly the same as invoking
 * `rfetch mkdir mydrive:private/backup/desktop`.
 *
 * There will be no special handling of paths containing `..` segments.
 * Invoking `rfetch mkdir backup:../desktop` is exactly the same as invoking
 * `rfetch mkdir mydrive:private/backup/../desktop`. The empty path is not
 * allowed as a remote. To alias the current directory use `.` instead.
 */

import { relink } from "@rfetch/lib/listing";
import { optionsOf, remoteHeaders } from "@rfetch/lib/options";
import { decodePath, encodePath } from "@rfetch/lib/path";

/**
 * Sends the requests to the remote of the alias with the global `fetch`.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RCLONE_ALIAS_*`.
 * @returns {Promise<Response>}
 */
async function alias(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);

  const remote = optionsOf(request, "alias", env).get("remote")
    ?.replace(/\/$/, "");
  if (!remote) {
    return new Response("Missing remote", { status: 400 });
  }
  const path = decodePath(pathname);
  if (path === null) {
    return new Response(null, { status: 400 });
  }

  // Delegates to the underlying remote.
  /** @type {RequestInit} */
  const init = {
    method,
    headers: remoteHeaders(request.headers, "alias", remote),
  };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  const response = await fetch(remote + encodePath(path), init);
  if (!response.ok) {
    return response;
  }

  // The links of a list and the location of a new file are in this remote,
  // not in the underlying remote.
  if (path.endsWith("/") && (method === "GET" || method === "HEAD")) {
    return relink(response, `${searchParams}`);
  }
  if (method === "PUT") {
    const headers = new Headers(response.headers);
    headers.set("Content-Location", pathname);
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

export default {
  fetch: alias,
};
