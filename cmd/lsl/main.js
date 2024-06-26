import { lsf } from "../../main.js";

/**
 * List the objects in path with modification time, size and path.
 *
 * Lists the objects in the source path in a human readable format with
 * modification time, size and path. Recurses by default.
 *
 * Example:
 *
 * ```js
 * import { lsl } from "./mod.js";
 * const response = await lsl("remote:path");
 * console.log(await response.text());
 * // 60295 2016-06-25 18:55:41.062626927 bevajer5jef
 * // 90613 2016-06-25 18:55:43.302607074 canole
 * // 94467 2016-06-25 18:55:43.046609333 diwogej7
 * // 37600 2016-06-25 18:55:40.814629136 fubuwic
 * ```
 *
 * @param {string} location
 * @param {Object} [flags={}]
 * @param {number} [flags.max_depth=Infinity] - Maximum depth of recursion.
 * @returns {Promise<Response>}
 */
export function lsl(location, flags = {}) {
  flags = {
    recursive: "true",
    max_depth: "Infinity",
    files_only: "true",
    format: "stp",
    separator: "\t",
    ...flags,
  };
  return lsf(location, flags);
}
