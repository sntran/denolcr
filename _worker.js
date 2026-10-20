/**
 * rfetch as a service: a stateless Worker. It keeps no configuration and no
 * secret: each request gives all that it needs.
 *
 * The path of a request is a remote and a path, as for the rfetch command,
 * for example `/:s3:bucket/a.txt`, `/r2:bucket/a.txt` or
 * `/:crypt,remote='r2:bucket':a.txt`. The options come in the headers
 * `RFETCH_*`, or `RCLONE_*` for compatibility, for example
 * `RFETCH_S3_ACCESS_KEY_ID` or the remote `RFETCH_CONFIG_R2_TYPE: s3`. A
 * header with an empty value is not an option. The fields of the query are options of the remote too, as the parameters of a
 * connection string. Do not put a secret in the query: a URL can stay in the
 * history of a browser and in logs.
 *
 * A `GET` with `Accept: application/json` gives the list of `rfetch lsjson`.
 * The header `Depth: N` lists N levels, and `Depth: infinity` all of them.
 *
 * The Worker is also a WebDAV server, as `rfetch serve webdav`: a WebDAV
 * client can use the URL of a remote, for example
 * `https://WORKER/:s3:bucket/`. The client gives the options in the headers
 * `RFETCH_*`, as for the other requests. COPY and MOVE can go from a remote
 * to another remote.
 *
 * A path with no remote is a static file of the site.
 */
// The import also sets the global `fetch`, which reads the paths of remotes.
import { fetch } from "./fetch.js";
import { lsjson } from "./cmd/lsjson/main.js";
import { handle } from "./cmd/serve/webdav/handler.js";
import { backends } from "./backend/main.js";
import { parse } from "@rfetch/lib/fspath";
import { isOption } from "@rfetch/lib/options";
import { decodeRemotePath } from "@rfetch/lib/path";

// The Worker has no files of its users, and a client tells all the options
// of its request: the local backend is not a backend of the Worker. Else a
// client could read the files of the runtime, for example with an alias to
// `/`.
delete backends.local;

/**
 * Gives the location of a request for the rfetch fetch: the remote of the
 * path with no percent-encoding, the fields of the query as parameters of
 * the remote, and the path with its percent-encoding.
 * @param {URL} url
 * @returns {string | null} `null` for a path with no remote.
 * @throws {SyntaxError} When the remote is not correct.
 */
function locationOf(url) {
  const raw = url.pathname.slice(1);
  if (raw === "") return null;
  const { name, path } = parse(raw);
  if (name === "") return null;
  let remote;
  try {
    remote = decodeURIComponent(raw.slice(0, raw.length - path.length));
  } catch {
    throw new SyntaxError(
      "The remote has a percent-encoding that is not correct",
    );
  }
  let params = "";
  for (const [key, value] of url.searchParams) {
    params += `,${key}='${value.replaceAll("'", "''")}'`;
  }
  // The remote ends with ":": the parameters go before it.
  return `${params ? remote.slice(0, -1) + params + ":" : remote}${path}`;
}

/**
 * The methods of WebDAV that the Worker answers as `rfetch serve webdav`.
 * DELETE is here too: a WebDAV client can delete a folder with no `/` at
 * the end of its path.
 */
const DAV = [
  "OPTIONS",
  "PROPFIND",
  "PROPPATCH",
  "MKCOL",
  "COPY",
  "MOVE",
  "LOCK",
  "UNLOCK",
  "DELETE",
];

/**
 * Gives the flags of `lsjson` for the header `Depth`.
 * @param {string | null} depth
 * @returns {Record<string, string> | null} `null` for a value that is not
 *   correct.
 */
function flagsOf(depth) {
  if (depth === null) return {};
  if (depth === "infinity") return { recursive: "true" };
  if (!/^[1-9]\d{0,3}$/.test(depth)) return null;
  return { recursive: "true", max_depth: depth };
}

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch: typeof fetch } }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const location = locationOf(url);
      if (location === null) return env.ASSETS.fetch(request);

      const { method, headers } = request;
      const accept = headers.get("Accept") ?? "";
      if (method === "GET" && /\bapplication\/json\b/.test(accept)) {
        const flags = flagsOf(headers.get("Depth"));
        if (flags === null) {
          return new Response("Depth is a number from 1 to 9999, or infinity", {
            status: 400,
          });
        }
        return await lsjson(location, flags, { headers });
      }

      if (DAV.includes(method)) {
        // The options of the client go to each request to the remote.
        const options = new Headers();
        for (const [name, value] of headers) {
          if (isOption(name)) options.set(name, value);
        }
        return await handle(request, {
          locate(pathname) {
            const target = locationOf(new URL(`${pathname}${url.search}`, url));
            if (target === null) {
              throw new SyntaxError("The path has no remote");
            }
            return target;
          },
          headers: options,
          root(pathname) {
            const raw = pathname.slice(1);
            const { name, path } = parse(raw);
            if (name === "") throw new SyntaxError("The path has no remote");
            return `/${raw.slice(0, raw.length - path.length)}`;
          },
          decode: decodeRemotePath,
        });
      }

      /** @type {RequestInit} */
      const init = { method, headers };
      if (request.body) {
        init.body = request.body;
        init.duplex = "half";
      }
      return await fetch(location, init);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return new Response(error.message, { status: 400 });
      }
      if (/ not found/.test(error.message)) {
        return new Response(error.message, { status: 404 });
      }
      throw error;
    }
  },
};
