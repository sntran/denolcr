/**
 * A backend is an interface to remote storage provider.
 *
 * Each backend implements the `fetch` method which takes a request and returns
 * a response, or a promise of a response.
 */

export { default as alias } from "./alias/main.ts";
export { default as chunker } from "./chunker/main.ts";
export { default as crypt } from "./crypt/main.ts";
export { default as drive } from "./drive/main.ts";
export { default as fshare } from "./fshare/main.ts";
export { default as local } from "./local/main.ts";
export { default as memory } from "./memory/main.ts";

export interface Backend {
  fetch(request: Request): Response | Promise<Response>;
}
