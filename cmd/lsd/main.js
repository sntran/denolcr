import { countField, sizeField } from "@rfetch/lib/format";
import { isTrue } from "@rfetch/lib/options";
import { toListTime } from "@rfetch/lib/time";
import { listLines } from "../lsf/main.js";
/**
 * List all directories/containers/buckets in the path.
 *
 * Lists the directories in the source path. Does not recurse by default. Use
 * the `--recursive` flag to recurse.
 *
 * @param {string} location
 * @param {Object} [flags={}]
 * @param {boolean} [flags.recursive=false] - Only list directories.
 * @returns {Promise<Response>}
 */
export function lsd(location, flags = {}) {
  const human = isTrue(flags.human_readable);
  // As `rclone lsd`: the size in 12 characters, the local time to the
  // second, the count of items in 9 characters, then the path. A folder has
  // no size and no count: -1 for both.
  return listLines(location, { recursive: false, ...flags }, (item) => {
    if (!item.IsDir) return;
    const time = toListTime(item.ModTime).padStart(13);
    const count = countField(-1, human, 9);
    return `${sizeField(item.Size, human, 12)} ${time} ${count} ${item.Path}`;
  });
}
