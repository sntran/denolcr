import { lsf } from "../../main.js";
/**
 * List the objects in the path with size and path.
 *
 * Lists the objects in the source path in a human readable format with size
 * and path. Recurses by default.
 *
 * Example:
 *
 * ```js
 * import { ls } from "./mod.js";
 * const response = await ls("remote:path");
 * console.log(await response.text());
 * // 60295 bevajer5jef
 * // 90613 canole
 * // 94467 diwogej7
 * // 37600 fubuwic
 * ```
 *
 * @param {string} location
 * @param {Object} [flags={}]
 * @param {number} [flags.max_depth=Infinity] - Maximum depth of recursion.
 * @returns {Promise<Response>}
 */
export function ls(location, flags = {}) {
  flags = {
    recursive: "true",
    max_depth: "Infinity",
    files_only: "true",
    format: "sp",
    separator: "\t",
    ...flags,
  };
  return lsf(location, flags);
}
