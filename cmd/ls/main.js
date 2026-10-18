import { sizeField } from "@rfetch/lib/format";
import { isTrue } from "@rfetch/lib/options";
import { listLines } from "../lsf/main.js";
/**
 * List the objects in the path with size and path.
 *
 * Lists the objects in the source path in a human readable format with size
 * and path. Recurses by default.
 *
 * Example:
 *
 * ```js
 * import { ls } from "./main.js";
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
  const human = isTrue(flags.human_readable);
  // As `rclone ls`: the size in 9 characters, then the path.
  return listLines(
    location,
    { recursive: true, max_depth: "Infinity", ...flags },
    (item) => {
      if (item.IsDir) return;
      return `${sizeField(item.Size, human, 9)} ${item.Path}`;
    },
  );
}
