/**
 * The options of a backend, from the three places of rclone: a flag, a
 * variable of the request, and a variable of the environment.
 *
 * A variable has the name of the option with the prefix `RFETCH_` and the
 * type of the backend, for example `RFETCH_S3_ACCESS_KEY_ID` for the option
 * `access_key_id` of s3. The prefix `RCLONE_` of rclone also works, for
 * compatibility: `RFETCH_` takes its place when both are set. In a request,
 * a variable is a header. The names of headers are not case sensitive.
 *
 * A header with an empty value is not an option: the variable of the
 * environment, or the default, stays. A proxy can copy a header that its
 * client did not send, as an empty header.
 */

/** The prefixes of the options, the primary one first. */
export const PREFIXES = ["rfetch_", "rclone_"];

/**
 * Tells if a flag or an option is on: `true`, or the text `true` of a query
 * or of a variable.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTrue(value) {
  return value === true || value === "true";
}

/**
 * Gives the options of a backend for a request: a field of the query
 * first, then the header `RFETCH_TYPE_NAME` or `RCLONE_TYPE_NAME`, then the
 * variable `RFETCH_TYPE_NAME` or `RCLONE_TYPE_NAME` of `env`, as a flag of
 * rclone takes the place of a variable.
 *
 * Use the options to read an option, and the query of the request to make
 * the links of a list: thus an option of a header or of `env` is never in a
 * link.
 * @param {Request} request
 * @param {string} type The type of the backend, for example `s3`.
 * @param {Record<string, unknown>} [env]
 * @returns {URLSearchParams}
 */
export function optionsOf(request, type, env = {}) {
  const options = new URL(request.url).searchParams;
  /** @param {string} key @param {string} value */
  const add = (key, value) => {
    if (!options.has(key)) options.set(key, value);
  };
  for (
    const prefix of PREFIXES.map((start) => `${start}${type.toLowerCase()}_`)
  ) {
    for (const [name, value] of request.headers) {
      if (name.startsWith(prefix) && value !== "") {
        add(name.slice(prefix.length), value);
      }
    }
  }
  for (
    const prefix of PREFIXES.map((start) => `${start}${type}_`.toUpperCase())
  ) {
    for (const [name, value] of Object.entries(env)) {
      if (name.startsWith(prefix) && typeof value === "string") {
        add(name.slice(prefix.length).toLowerCase(), value);
      }
    }
  }
  return options;
}

/**
 * Tells if a header is an option of rfetch or of rclone.
 * @param {string} name
 */
export function isOption(name) {
  const lower = name.toLowerCase();
  return PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Gives the headers of a request of a backend to the remote under it.
 *
 * The other options of the request go to the remote, for example the
 * remotes of `RFETCH_CONFIG_NAME_KEY`. The options of the backend itself do
 * not go: they are not for the remote. When the remote is a URL, no option
 * goes: a secret must not go out to a server.
 * @param {HeadersInit} headers The headers of the request of the backend.
 * @param {string} type The type of the backend, for example `crypt`.
 * @param {string} remote The remote under the backend.
 * @returns {Headers}
 */
export function remoteHeaders(headers, type, remote) {
  const result = new Headers(headers);
  const own = PREFIXES.map((prefix) => `${prefix}${type.toLowerCase()}_`);
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(remote);
  for (const name of [...result.keys()]) {
    const remove = url
      ? isOption(name)
      : own.some((prefix) => name.startsWith(prefix));
    if (remove) result.delete(name);
  }
  return result;
}
