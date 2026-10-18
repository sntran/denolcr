/**
 * The `fetch` of rfetch, which reads the paths of remotes. The import of this
 * module sets it as the global `fetch`. A command imports this module and
 * not mod.js: mod.js exports all the commands, which take much time to load.
 */
import process, { env } from "node:process";
import { backends, load } from "./backend/main.js";
import { parse } from "@rfetch/lib/fspath";
import { isOption, PREFIXES } from "@rfetch/lib/options";

/**
 * @typedef {Object<string, string> & { type: string }} Remote
 */

const globalFetch = globalThis.fetch;

/**
 * A `fetch` with support for remote URL. The import of this module sets it
 * as the global `fetch`. Thus a backend on top of other remotes, for example
 * crypt, calls `fetch(":memory:/path")` and does not import rfetch.
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
 * - Remote specific environment vars, e.g. `RFETCH_CONFIG_MYREMOTE_SKIP_LINKS`
 * - Backend-specific environment vars, e.g. `RFETCH_LOCAL_SKIP_LINKS`
 * - Backend generic environment vars, e.g. `RFETCH_SKIP_LINKS`
 * - Config file, e.g. `skip_links = true`.
 * - Default values, e.g. `false` - these can't be changed.
 *
 * So if both `--skip-links` is supplied on the command line and an environment
 * variable `RFETCH_LOCAL_SKIP_LINKS` is set, the command line flag will take
 * preference.
 *
 * Each variable can also have the prefix `RCLONE_` of rclone, for
 * compatibility, for example `RCLONE_LOCAL_SKIP_LINKS`. In each place,
 * `RFETCH_` takes the place of `RCLONE_`.
 *
 * A header of the request with the name of a variable, for example
 * `RFETCH_CONFIG_MYREMOTE_SKIP_LINKS`, takes the place of the variable of the
 * environment. A remote can come only from variables, as in rclone:
 * `RFETCH_CONFIG_MYREMOTE_TYPE` and its options. Thus a request can give
 * all its configuration, with no config file.
 *
 * The backend gets the options of the path, the connection string and the
 * flags, in the query of its request. It gets the other options in `env`,
 * the second argument of its `fetch`, with the names of the variables of
 * rfetch, for example `RFETCH_LOCAL_SKIP_LINKS`. A backend makes the links of
 * a list from the query only, thus an option of `env` is never in a link.
 *
 * The headers `RFETCH_*` and `RCLONE_*` are only for the backends of rfetch:
 * they never go
 * out to a URL.
 *
 * For non backend configuration the order is as follows:
 *
 * - Flag values as supplied on the command line, e.g. `--stats 5s`.
 * - Environment vars, e.g. `RFETCH_STATS=5s`.
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
    return globalFetch(...withoutOptions(input, init));
  }

  // The parts of the path, as rclone reads them. It throws a SyntaxError
  // for a path that is not correct.
  const parsed = parse(input);

  const headers = new Headers(init.headers);
  // The variables, by their names with no prefix, for example
  // `CONFIG_R2_TYPE`: the environment of the process, then the headers of
  // the request, which take their place. In each place, `RFETCH_` takes the
  // place of `RCLONE_`.
  /** @type {Record<string, string>} */
  const variables = {};
  const places = [
    variablesOf(env),
    [...headers].map(([key, value]) => [key.toUpperCase(), value]),
  ];
  for (const entries of places) {
    for (const prefix of ["RCLONE_", "RFETCH_"]) {
      for (const [key, value] of entries) {
        if (key.startsWith(prefix) && typeof value === "string") {
          variables[key.slice(prefix.length)] = value;
        }
      }
    }
  }

  let { name } = parsed;

  /**
   * @type {Remote}
   */
  let config;

  if (name === "") { // A local path.
    config = { type: "local" };
  } else if (name.startsWith(":")) { // `:type:path/to/file`
    config = { type: name.slice(1) };
    name = "";
  } else {
    // A remote of the config file, or of the variables, as rclone.
    const type = variables[`CONFIG_${name.toUpperCase()}_TYPE`];
    // The command config reads the config file. It loads only for a remote
    // with a name.
    const { config: command } = await import("./cmd/config/main.js");
    const response = await command("show", name, undefined, {
      headers: { "Accept": "application/json" },
    }).catch(() => null);
    if (response?.ok) {
      config = await response.json();
    } else if (type) {
      config = {};
    } else {
      throw new Error(`Remote ${name} not found in config.`);
    }
    if (type) config.type = type;
  }

  const type = config.type;
  delete config.type;

  // The options that are not in the path, from the lowest precedence: the
  // config file, then the variables.
  const options = new Map(Object.entries(config));

  // Backend generic variables, for example `RFETCH_SKIP_LINKS`. A variable
  // of a remote or of a backend is not generic: it is not an option of each
  // backend.
  const specific = ["CONFIG", ...Object.keys(backends)]
    .map((prefix) => `${prefix.toUpperCase()}_`);
  for (const [key, value] of Object.entries(variables)) {
    if (specific.some((prefix) => key.startsWith(prefix))) continue;
    options.set(key.toLowerCase(), value);
  }

  // Backend-specific variables, for example `RFETCH_LOCAL_SKIP_LINKS`.
  let prefix = `${type.toUpperCase()}_`;
  for (const [key, value] of Object.entries(variables)) {
    if (key.startsWith(prefix)) {
      options.set(key.slice(prefix.length).toLowerCase(), value);
    }
  }

  // Remote specific variables, for example `RFETCH_CONFIG_MYREMOTE_SKIP_LINKS`.
  if (name) {
    prefix = `CONFIG_${name.toUpperCase()}_`;
    for (const [key, value] of Object.entries(variables)) {
      if (key.startsWith(prefix) && key !== `${prefix}TYPE`) {
        options.set(key.slice(prefix.length).toLowerCase(), value);
      }
    }
  }

  // A local path, of the command line or of the code, is relative to the
  // current folder, as in rclone: for example `file.txt`, `../file.txt` or
  // `/tmp/file.txt`. Only such a path gives the root `/` to the local
  // backend. The Worker gives no such path: a path with no remote is a file
  // of its site.
  let location = new URL(parsed.path, "file:");
  /** @type {string | undefined} */
  let root;
  if (parsed.name === "") {
    const { pathToFileURL } = await import("node:url");
    const folder = pathToFileURL(process.cwd());
    if (!folder.pathname.endsWith("/")) folder.pathname += "/";
    location = new URL(parsed.path, folder);
    root = "/";
  }
  // `searchParams` may contain other flags not for the current backend.
  const { pathname, searchParams } = location;

  // The query of the backend: the flags prefixed with the backend type, then
  // the parameters in the connection string, which take their place.
  const params = new URLSearchParams();
  searchParams.forEach((value, key) => {
    if (key.startsWith(`${type}_`)) {
      params.set(key.replace(`${type}_`, ""), value);
    }
  });
  for (const [key, value] of Object.entries(parsed.config)) {
    params.set(key, value);
  }

  // The other options go in `env`. The backend reads its query first, as a
  // flag takes the place of a variable.
  /** @type {Record<string, string>} */
  const optionsEnv = {};
  for (const [key, value] of options) {
    optionsEnv[`RFETCH_${type.toUpperCase()}_${key.toUpperCase()}`] = value;
  }
  // The root of the local backend is not an option: a config file, a
  // variable, a header or the query cannot set it.
  delete optionsEnv.RFETCH_LOCAL_ROOT;
  if (root !== undefined) optionsEnv.RFETCH_LOCAL_ROOT = root;
  // The headers of this backend are in its options now.
  const own = PREFIXES.map((start) => `${start}${type.toLowerCase()}_`);
  for (const key of [...headers.keys()]) {
    if (own.some((start) => key.startsWith(start))) headers.delete(key);
  }

  if (init.method === "TRACE") {
    let body = `TRACE ${pathname}?${params} HTTP/1.1\r`;
    // Reflects the request as response body, then the options in `env`.
    for (const [name, value] of headers) {
      body += `${name}: ${value}\r`;
    }
    for (const [name, value] of Object.entries(optionsEnv)) {
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

  const backend = await load(type);
  if (!backend) {
    throw new Error(`Backend ${type} not found.`);
  }

  const url = new URL(`${pathname}?${params}`, import.meta.url || `file:`);
  // Creates a new request with the initial init.
  const request = new Request(url, init);
  // Clones that request and updates the headers.
  return backend.fetch(
    new Request(request, {
      headers,
    }),
    optionsEnv,
  );
}

/**
 * Gives the variables `RFETCH_*` and `RCLONE_*` of the environment of the
 * process. It reads only the names, then the values of these variables:
 * Node.js reads each value of `process.env` from the system, which takes
 * much time.
 * @param {Record<string, string | undefined>} variables
 * @returns {[string, string][]}
 */
function variablesOf(variables) {
  /** @type {[string, string][]} */
  const entries = [];
  for (const key of Object.keys(variables)) {
    if (key.startsWith("RFETCH_") || key.startsWith("RCLONE_")) {
      const value = variables[key];
      if (typeof value === "string") entries.push([key, value]);
    }
  }
  return entries;
}

/**
 * Removes the options of rclone from a request to a URL: they are only for
 * the backends of rfetch.
 * @param {string | Request | URL} input
 * @param {RequestInit} init
 * @returns {[string | Request | URL, RequestInit]}
 */
function withoutOptions(input, init) {
  /** @param {HeadersInit} [from] */
  const clean = (from) => {
    const headers = new Headers(from);
    for (const key of [...headers.keys()]) {
      if (isOption(key)) headers.delete(key);
    }
    return headers;
  };
  if (input instanceof Request) {
    input = new Request(input, { headers: clean(input.headers) });
  }
  if (init.headers !== undefined) {
    init = { ...init, headers: clean(init.headers) };
  }
  return [input, init];
}

// The other URLs go to the original `fetch`.
globalThis.fetch = fetch;
