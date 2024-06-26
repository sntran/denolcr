import { fetch } from "../../main.js";

/**
 * Copies standard input to file on remote.
 * @param {string} destination
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export function rcat(destination, flags) {
  return fetch(`${destination}?${new URLSearchParams(flags)}`, {
    method: "PUT",
    // TODO: Switch to `node:process.stdin`.
    body: Deno.stdin.readable,
  });
}
