/**
 * Combine remote
 *
 * The `combine` remote puts several remotes in one tree of folders, as the
 * combine backend of rclone. Each remote is a folder at the root of the
 * combine remote.
 *
 * The option `upstreams` tells the folders and their remotes, with a space
 * between them:
 *
 * ```
 * upstreams = images=s3:imagesbucket files=drive:important/files
 * ```
 *
 * Then `combine:images/a.png` is `s3:imagesbucket/a.png`, and
 * `combine:files/b.txt` is `drive:important/files/b.txt`. A value with a
 * space is in quotes: `"My Drive=drive:" "Shared=drive,shared_with_me:"`.
 *
 * The root of the combine remote has only the folders of the upstreams. A
 * file cannot be in the root, and the root always exists.
 */

import { parseList } from "@rfetch/lib/list";
import { relink, renderListing } from "@rfetch/lib/listing";
import { optionsOf, remoteHeaders } from "@rfetch/lib/options";
import { encodeLocation } from "@rfetch/lib/fspath";
import { decodePath, encodePath } from "@rfetch/lib/path";

/**
 * The options of the backend, with their types, for example for the flag
 * `--combine-upstreams` of the command line.
 */
export const options = {
  string: ["upstreams"],
};

/**
 * Reads the option `upstreams`, as rclone.
 * @param {string} text For example `images=s3:bucket "my files=drive:a b"`.
 * @returns {Map<string, string>} The remote of each folder of the root.
 * @throws {Error} With the message of rclone, when the option is not
 *   correct.
 */
export function upstreamsOf(text) {
  /** @type {Map<string, string>} */
  const upstreams = new Map();
  // `SpaceSepList` of rclone: one record of CSV with a space between the
  // values.
  const values = text === "" ? [] : parseList(text, " ");
  if (values.length === 0) {
    throw new Error(
      "combine can't point to an empty upstream - check the value of the upstreams setting",
    );
  }
  for (const value of values) {
    const equal = value.indexOf("=");
    if (equal === -1) {
      throw new Error(`no "=" in upstream definition ${quote(value)}`);
    }
    const dir = value.slice(0, equal);
    const remote = value.slice(equal + 1);
    if (dir === "") {
      throw new Error(`empty dir in upstream definition ${quote(value)}`);
    }
    if (remote === "") {
      throw new Error(`empty remote in upstream definition ${quote(value)}`);
    }
    if (dir.includes("/")) {
      throw new Error(`dirs can't contain / (yet): ${quote(dir)}`);
    }
    if (upstreams.has(dir)) {
      throw new Error(`duplicate directory name ${quote(dir)}`);
    }
    upstreams.set(dir, remote);
  }
  return upstreams;
}

/**
 * A text in quotes, as `%q` of Go for the most texts.
 * @param {string} text
 */
function quote(text) {
  return JSON.stringify(text);
}

/**
 * The location of a path in the remote of an upstream.
 * @param {string} remote For example `s3:bucket` or `:memory:/a/`.
 * @param {string} path The path in the upstream, for example `/b c.txt`.
 * @returns {string} For example `s3:bucket/b%20c.txt`.
 */
function locationOf(remote, path) {
  return encodeLocation(remote.replace(/\/$/, "")) + encodePath(path);
}

/**
 * Sends the requests to the remotes of the upstreams with the global
 * `fetch`.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_COMBINE_*` or `RCLONE_COMBINE_*`.
 * @returns {Promise<Response>}
 */
async function combine(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);

  /** @type {Map<string, string>} */
  let upstreams;
  try {
    upstreams = upstreamsOf(
      optionsOf(request, "combine", env).get("upstreams") ?? "",
    );
  } catch (error) {
    return new Response(/** @type {Error} */ (error).message, { status: 400 });
  }
  const path = decodePath(pathname);
  if (path === null) {
    return new Response(null, { status: 400 });
  }

  if (path === "/") {
    return root(request, upstreams, `${searchParams}`);
  }

  // The first name of the path is the folder of an upstream.
  const slash = path.indexOf("/", 1);
  const remote = upstreams.get(path.slice(1, slash === -1 ? undefined : slash));
  // A file cannot be in the root: the name of an upstream is a folder.
  if (remote === undefined || slash === -1) {
    await request.body?.cancel();
    return new Response("directory not found", { status: 404 });
  }

  /** @type {RequestInit} */
  const init = {
    method,
    headers: remoteHeaders(request.headers, "combine", remote),
  };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  const response = await fetch(locationOf(remote, path.slice(slash)), init);
  if (!response.ok) {
    return response;
  }

  // The links of a list and the location of a new file are in this remote,
  // not in the remote of the upstream.
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

/**
 * The answer for the root, which has a folder for each upstream.
 * @param {Request} request
 * @param {Map<string, string>} upstreams
 * @param {string} query The query of the links of the list.
 * @returns {Promise<Response>}
 */
async function root(request, upstreams, query) {
  const { method } = request;
  if (method === "GET" || method === "HEAD") {
    // As rclone, the folders have the time of now.
    const now = new Date().toISOString();
    const entries = [...upstreams.keys()].map((Name) => ({
      Name,
      IsDir: true,
      Size: -1,
      MimeType: "",
      ModTime: now,
    }));
    return new Response(
      method === "GET" ? renderListing(entries, { query }) : null,
      { headers: { "Content-Type": "text/html;charset=utf-8" } },
    );
  }
  if (method === "PUT") {
    // The root always exists.
    await request.body?.cancel();
    return new Response(null, {
      status: 201,
      headers: { "Content-Location": "/" },
    });
  }
  if (method === "DELETE") {
    // As `rclone purge` of the root: it deletes the root of each upstream.
    const responses = await Promise.all(
      [...upstreams.values()].map((remote) =>
        fetch(locationOf(remote, "/"), {
          method: "DELETE",
          headers: remoteHeaders(request.headers, "combine", remote),
        })
      ),
    );
    // A root that does not exist is already deleted.
    const failed = responses.find(({ ok, status }) => !ok && status !== 404);
    for (const response of responses) {
      if (response !== failed) await response.body?.cancel();
    }
    return failed ?? new Response(null, { status: 204 });
  }
  await request.body?.cancel();
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET, HEAD, PUT, DELETE" },
  });
}

export default {
  fetch: combine,
};
