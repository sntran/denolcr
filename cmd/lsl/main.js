import { sizeField } from "@rfetch/lib/format";
import { isTrue } from "@rfetch/lib/options";
import { toListTime } from "@rfetch/lib/time";
import { listLines } from "../lsf/main.js";

/**
 * List the objects in path with modification time, size and path.
 *
 * Lists the objects in the source path in a human readable format with
 * modification time, size and path. Recurses by default.
 *
 * Example:
 *
 * ```js
 * import { lsl } from "./main.js";
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
  const human = isTrue(flags.human_readable);
  // As `rclone lsl`: the size in 9 characters, the local time to the
  // nanosecond, then the path.
  return listLines(
    location,
    { recursive: true, max_depth: "Infinity", ...flags },
    (item) => {
      if (item.IsDir) return;
      const time = toListTime(item.ModTime, 9);
      return `${sizeField(item.Size, human, 9)} ${time} ${item.Path}`;
    },
  );
}
