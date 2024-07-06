/**
 * A backend is an interface to remote storage provider.
 *
 * Each backend implements the `fetch` method which takes a request and returns
 * a response, or a promise of a response.
 *
 * @typedef {Object} Backend
 * @property {(request: Request) => Response | Promise<Response>} fetch
 */

export { default as alias } from "./alias/main.js";
export { default as chunker } from "./chunker/main.js";
export { default as crypt } from "./crypt/main.js";
export { default as drive } from "./drive/main.js";
export { default as http } from "./http/main.js";
export { default as local } from "./local/main.js";
export { default as memory } from "./memory/main.js";
