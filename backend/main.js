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
 * such a path: `mod.js` in Node.js, and `_worker.js` in a Worker.
 *
 * @typedef {Object} Backend
 * @property {(request: Request, env?: Object) => Response | Promise<Response>} fetch
 */

export { default as alias } from "./alias/main.js";
export { default as chunker } from "./chunker/main.js";
export { default as crypt } from "./crypt/main.js";
export { default as drive } from "./drive/main.js";
export { default as http } from "./http/main.js";
export { default as local } from "./local/main.js";
export { default as memory } from "./memory/main.js";
export { default as s3 } from "./s3/main.js";
