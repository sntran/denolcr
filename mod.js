import { env } from "node:process";
import * as backends from "./backend/main.js";
import * as commands from "./cmd/main.js";

export * from "./cmd/main.js";

export { Progress } from "./lib/streams/progress.js";

/**
 * @typedef {Object<string, string>} Options
 */

/**
 * @typedef {(args: string[], options?: Options) => Promise<Response>} Command
 */

/**
 * @typedef {Options & { type: string }} Remote
 */

/**
 * File represents a file or directory.
 * @typedef {Object} File
 * @property {string} ID
 * @property {string} OrigID
 * @property {boolean} IsDir
 * @property {string} MimeType
 * @property {string} ModTime
 * @property {string} Name
 * @property {string} Encrypted
 * @property {string} EncryptedPath
 * @property {string} Path
 * @property {number} Size
 * @property {string} Tier
 * @property {Object} Metadata
 */

const REMOTE_REGEX =
  /^(:)?(?:([\w.][\w.\s-]*(?:,[\w=,"'*#.:@%-_\/]+)?):)?([^:]*)$/;

const globalFetch = globalThis.fetch;

/**
 * Extended global `fetch` with support for remote URL.
 *
 * The syntax of the paths passed to the rfetch command are as follows.
 *
 * `/path/to/dir``
 *
 * This refers to the local file system.
 *
 * On Windows `\` may be used instead of `/` in local paths only, non local
 * paths must use `/`.
 *
 * These paths needn't start with a leading `/` - if they don't then they
 * will be relative to the current directory.
 *
 * `remote:path/to/dir`
 *
 * This refers to a directory `path/to/dir` on `remote:` as defined in the
 * config.
 *
 * `remote:/path/to/dir`
 *
 * On most backends this refers to the same directory as `remote:path/to/dir`
 * and that format should be preferred. On a very small number of remotes
 * (FTP, SFTP, ..) this will refer to a different directory. On these, paths
 * without a leading `/` will refer to your "home" directory and paths with a
 * leading `/` will refer to the root.
 *
 * `:backend:path/to/dir`
 *
 * This is an advanced form for creating remotes on the fly. `backend` should
 * be the name or prefix of a backend (the `type` in the config file) and all
 * the configuration for the backend should be provided on the command line
 * (or in environment variables).
 *
 * ## Precedence
 *
 * The various different methods of backend configuration are read in this
 * order and the first one with a value is used.
 *
 * - Parameters in connection strings, e.g. `myRemote,skip_links:`
 * - Flag values as supplied on the command line, e.g. `--skip-links`
 * - Remote specific environment vars, e.g. `RCLONE_CONFIG_MYREMOTE_SKIP_LINKS`
 * - Backend-specific environment vars, e.g. `RCLONE_LOCAL_SKIP_LINKS`
 * - Backend generic environment vars, e.g. `RCLONE_SKIP_LINKS`
 * - Config file, e.g. `skip_links = true`.
 * - Default values, e.g. `false` - these can't be changed.
 *
 * So if both `--skip-links` is supplied on the command line and an environment
 * variable `RCLONE_LOCAL_SKIP_LINKS` is set, the command line flag will take
 * preference.
 *
 * For non backend configuration the order is as follows:
 *
 * - Flag values as supplied on the command line, e.g. `--stats 5s`.
 * - Environment vars, e.g. `RCLONE_STATS=5s`.
 * - Default values, e.g. `1m` - these can't be changed.
 *
 * ## Other environment variables
 *
 * @param {string | Request | URL} input
 * @param { RequestInit} [init={}]
 * @returns {Promise<Response>}
 */
export async function fetch(input, init = {}) {
  if (
    typeof input !== "string" || input.startsWith("https://") ||
    input.startsWith("http://") || input.startsWith("file://")
  ) {
    return globalFetch(input, init);
  }

  const [, colon, remote = "local", path] = input.match(REMOTE_REGEX) || [];
  if (!remote && !path) {
    return globalFetch(input, init);
  }

  // The final params.
  const params = new URLSearchParams();

  /**
   * Sets backend generic environment vars first.
   */
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("RCLONE_")) {
      const shortKey = key.slice(7).toLowerCase();
      params.set(shortKey, value);
    }
  }

  // Remote can be connection string with arguments separated by commas.
  let [name, ...args] = remote.split(",");

  /**
   * @type {Remote}
   */
  let config;

  if (colon || remote === "local") { // the location has format `:type:path/to/file`
    config = { type: name };
    name = "";
  } else {
    const response = await commands.config("show", name, undefined, {
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Remote ${name} not found in config.`);
    }
    config = await response.json();
  }

  const type = config.type;
  delete config.type;

  // Stores config into params if not already set, with lowest precedence.
  Object.entries(config).forEach(([key, value]) => {
    if (!params.has(key)) {
      params.set(key, value);
    }
  });

  // Overrides with backend-specific environment vars.
  let envPrefix = `RCLONE_${type.toUpperCase()}_`;
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(envPrefix)) {
      const shortKey = key.slice(envPrefix.length).toLowerCase();
      params.set(shortKey, value);

      // Deletes any params that are already set by environment vars.
      params.delete(`${type}_${shortKey}`);
    }
  }

  // Overrides with remote specific environment vars
  envPrefix = `RCLONE_CONFIG_${name.toUpperCase()}_`;
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(envPrefix)) {
      const shortKey = key.slice(envPrefix.length).toLowerCase();
      params.set(shortKey, value);

      // Deletes any params that are already set by environment vars.
      params.delete(`config_${name}_${shortKey}`);
    }
  }

  // `searchParams` may contain other flags not for the current backend.
  const { pathname, searchParams } = new URL(path, "file:");

  // Overrides with flags in request's search params.
  searchParams.forEach((value, key) => {
    if (key.startsWith(`${type}_`)) {
      params.set(key.replace(`${type}_`, ""), value);
    }
  });

  // Overrides with parameters in connection string.
  args.forEach((arg) => {
    const [key, value = "true"] = arg.split("=");
    // `value` can be encoded through URLSearchParams.
    params.set(key, decodeURIComponent(value));
  });

  const headers = new Headers(init.headers);

  if (init.method === "TRACE") {
    let body = `TRACE ${pathname}?${params} HTTP/1.1\r`;
    // Reflects the request as response body.
    for (const [name, value] of headers) {
      body += `${name}: ${value}\r`;
    }
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "message/http",
        "Via": `${type}/1.1 ${name}`.trim(),
      },
    });
  }

  if (init.body instanceof ReadableStream) {
    // @ts-ignore: Must have `duplex` for streaming body
    init.duplex = "half"; // Must set this for stream body.
  }

  /**
   * @type {import("./backend/main.js").Backend}
   */
  const backend = backends[type];

  const url = new URL(`${pathname}?${params}`, import.meta.url || `file:`);
  // Creates a new request with the initial init.
  const request = new Request(url, init);
  // Clones that request and updates the headers.
  return backend.fetch(
    new Request(request, {
      headers,
    }),
  );
}

globalThis.fetch = fetch;
