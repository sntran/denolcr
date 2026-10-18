import { countField, sizeField } from "@rfetch/lib/format";
import { isTrue } from "@rfetch/lib/options";
import { toListTime } from "@rfetch/lib/time";
import { LineStream, lsjson } from "../lsjson/main.js";
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
export async function lsd(location, flags = {}) {
  const human = isTrue(flags.human_readable);
  const response = await lsjson(location, { recursive: false, ...flags });
  if (!response.ok) return response;
  // As `rclone lsd`: the size in 12 characters, the local time to the
  // second, the count of items in 9 characters, then the path. A folder has
  // no size and no count: -1 for both.
  const lines = new LineStream((item) => {
    if (!item.IsDir) return;
    const time = toListTime(item.ModTime).padStart(13);
    const count = countField(-1, human, 9);
    return `${sizeField(item.Size, human, 12)} ${time} ${count} ${item.Path}`;
  });
  return new Response(response.body.pipeThrough(lines), {
    headers: { "Content-Type": "text/plain" },
  });
}
