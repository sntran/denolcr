/**
 * A backend is an interface to remote storage provider.
 *
 * Each backend implements the `fetch` method which takes a request and returns
 * a response, or a promise of a response, as a Worker of Cloudflare. A backend
 * imports nothing of rfetch: it gets all from the request and from `env`.
 *
 * A backend on top of another remote, for example crypt, sends its requests
 * to that remote with `env.REMOTE.fetch`, as a service binding of
 * Cloudflare. With no `REMOTE`, it uses the global `fetch`.
 *
 * @typedef {Object} Backend
 * @property {(request: Request, env?: Env) => Response | Promise<Response>} fetch
 */

/**
 * @typedef {Object} Env
 * @property {{ fetch: typeof fetch }} [REMOTE] Gets the requests to the
 *   remote under the backend.
 */

export { default as alias } from "./alias/main.js";
export { default as chunker } from "./chunker/main.js";
export { default as crypt } from "./crypt/main.js";
export { default as drive } from "./drive/main.js";
export { default as http } from "./http/main.js";
export { default as local } from "./local/main.js";
export { default as memory } from "./memory/main.js";
