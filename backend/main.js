/**
 * A backend is an interface to remote storage provider.
 *
 * Each backend implements the `fetch` method which takes a request and returns
 * a response, or a promise of a response, as a Worker of Cloudflare. A backend
 * imports nothing of rfetch: it gets all from the request and from `env`.
 *
 * A backend on top of another remote, for example crypt, sends its requests
 * to that remote with the global `fetch`, for example
 * `fetch(":memory:/path")`. The host sets the global `fetch` that reads
 * such a path: the import of `fetch.js` sets it, in Node.js and in a Worker.
 *
 * @typedef {Object} Backend
 * @property {(request: Request, env?: Object) => Response | Promise<Response>} fetch
 */

/**
 * The backends of rfetch, by type. Each backend is the npm package
 * `@rfetch/TYPE`. It loads at its first use, thus rfetch loads only the
 * backends that it needs. The names of the packages are literal, thus a
 * bundler, for example the bundler of wrangler, can find them.
 * @type {Record<string, () => Promise<{ default: Backend }>>}
 */
export const backends = {
  alias: () => import("@rfetch/alias"),
  archive: () => import("@rfetch/archive"),
  azureblob: () => import("@rfetch/azureblob"),
  chunker: () => import("@rfetch/chunker"),
  combine: () => import("@rfetch/combine"),
  compress: () => import("@rfetch/compress"),
  crypt: () => import("@rfetch/crypt"),
  doi: () => import("@rfetch/doi"),
  drive: () => import("@rfetch/drive"),
  ftp: () => import("@rfetch/ftp"),
  http: () => import("@rfetch/http"),
  local: () => import("@rfetch/local"),
  memory: () => import("@rfetch/memory"),
  s3: () => import("@rfetch/s3"),
  sftp: () => import("@rfetch/sftp"),
  tiles: () => import("@rfetch/tiles"),
  union: () => import("@rfetch/union"),
  webdav: () => import("@rfetch/webdav"),
};

/**
 * Loads a backend.
 * @param {string} type For example `crypt`.
 * @returns {Promise<Backend | undefined>} `undefined` for a type that is not
 *   a backend of rfetch.
 */
export async function load(type) {
  if (!Object.hasOwn(backends, type)) return undefined;
  const { default: backend } = await backends[type]();
  return backend;
}
