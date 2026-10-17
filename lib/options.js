/**
 * The options of a backend, from the three places of rclone: a flag, a
 * variable of the request, and a variable of the environment.
 *
 * A variable has the name of the variable of rclone, for example
 * `RCLONE_S3_ACCESS_KEY_ID` for the option `access_key_id` of s3. In a
 * request, it is a header. The names of headers are not case sensitive.
 */

/** The start of the name of a header that is an option of rclone. */
const PREFIX = "rclone_";

/**
 * Gives the options of a backend for a request: a field of the query
 * first, then the header `RCLONE_TYPE_NAME`, then the variable
 * `RCLONE_TYPE_NAME` of `env`, as a flag of rclone takes the place of a
 * variable.
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
  const prefix = `${PREFIX}${type.toLowerCase()}_`;
  for (const [name, value] of request.headers) {
    if (!name.startsWith(prefix)) continue;
    const key = name.slice(prefix.length);
    if (!options.has(key)) options.set(key, value);
  }
  const variable = prefix.toUpperCase();
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(variable) || typeof value !== "string") continue;
    const key = name.slice(variable.length).toLowerCase();
    if (!options.has(key)) options.set(key, value);
  }
  return options;
}

/**
 * Tells if a header is an option of rclone.
 * @param {string} name
 */
export function isOption(name) {
  return name.toLowerCase().startsWith(PREFIX);
}

/**
 * Gives the headers of a request of a backend to the remote under it.
 *
 * The other options of the request go to the remote, for example the
 * remotes of `RCLONE_CONFIG_NAME_KEY`. The options of the backend itself do
 * not go: they are not for the remote. When the remote is a URL, no option
 * goes: a secret must not go out to a server.
 * @param {HeadersInit} headers The headers of the request of the backend.
 * @param {string} type The type of the backend, for example `crypt`.
 * @param {string} remote The remote under the backend.
 * @returns {Headers}
 */
export function remoteHeaders(headers, type, remote) {
  const result = new Headers(headers);
  const own = `${PREFIX}${type.toLowerCase()}_`;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(remote);
  for (const name of [...result.keys()]) {
    if (url ? isOption(name) : name.startsWith(own)) result.delete(name);
  }
  return result;
}
