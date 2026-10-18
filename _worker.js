/**
 * rfetch as a service: a stateless Worker. It keeps no configuration and no
 * secret: each request gives all that it needs.
 *
 * The path of a request is a remote and a path, as for the rfetch command,
 * for example `/:s3:bucket/a.txt`, `/r2:bucket/a.txt` or
 * `/:crypt,remote='r2:bucket':a.txt`. The options come in the headers
 * `RFETCH_*`, or `RCLONE_*` for compatibility, for example
 * `RFETCH_S3_ACCESS_KEY_ID` or the remote `RFETCH_CONFIG_R2_TYPE: s3`. The
 * fields of the query are options of the remote too, as the parameters of a
 * connection string. Do not put a secret in the query: a URL can stay in the
 * history of a browser and in logs.
 *
 * A `GET` with `Accept: application/json` gives the list of `rfetch lsjson`.
 * The header `Depth: N` lists N levels, and `Depth: infinity` all of them.
 *
 * A path with no remote is a static file of the site.
 */
// The import also sets the global `fetch`, which reads the paths of remotes.
import { fetch, lsjson } from "./mod.js";
import { parse } from "@rfetch/lib/fspath";

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
