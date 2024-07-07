import process from "node:process";
import { fetch } from "../../mod.js";

/**
 * Copies standard input to file on remote.
 * @param {string} destination
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export function rcat(destination, flags) {
  const body = new ReadableStream({
    start(controller) {
      process.stdin.on("data", (chunk) => {
        controller.enqueue(chunk);
      });
      process.stdin.on("end", () => {
        controller.close();
      });
    },
  });

  return fetch(`${destination}?${new URLSearchParams(flags)}`, {
    method: "PUT",
    body,
  });
}
