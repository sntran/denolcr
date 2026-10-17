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

import { relink } from "../../lib/listing.js";
import { decodePath, encodePath } from "../../lib/path.js";

/**
 * @param {Request} request
 * @param {{ REMOTE?: { fetch: typeof fetch } }} [env] `REMOTE` gets the
 *   requests to the remote of the alias, as a service binding of Cloudflare.
 *   With no `REMOTE`, the global `fetch` gets them.
 * @returns {Promise<Response>}
 */
async function alias(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);

  const remote = searchParams.get("remote")?.replace(/\/$/, "");
  if (!remote) {
    return new Response("Missing remote", { status: 400 });
  }
  const path = decodePath(pathname);
  if (path === null) {
    return new Response(null, { status: 400 });
  }

  // Delegates to the underlying remote.
  /** @type {RequestInit} */
  const init = { method, headers: request.headers };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  const fetcher = env.REMOTE ?? globalThis;
  const response = await fetcher.fetch(remote + encodePath(path), init);
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
