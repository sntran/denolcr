import { countString, sizeString } from "@rfetch/lib/format";
import { isTrue } from "@rfetch/lib/options";

import { failure, log, OperationError, stat, walk } from "../operations.js";

/**
 * Prints the total size and number of objects in remote:path, as `rclone
 * size`:
 *
 * ```text
 * Total objects: 3
 * Total size: 11 B (11 Byte)
 * ```
 *
 * With `--json`, it gives `{"count":3,"bytes":11,"sizeless":0}`. A file with
 * no size counts as 0 bytes, and in `sizeless`.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function size(location, flags = {}) {
  try {
    const info = await stat(location, flags);
    if (!info) throw new OperationError("directory not found", 404);
    let count = 0, bytes = 0, sizeless = 0;
    /** @param {number} value */
    const add = (value) => {
      count++;
      if (value >= 0) bytes += value;
      else sizeless++;
    };
    if (info.isDir) {
      for await (const item of await walk(location, flags)) {
        if (!item.IsDir) add(item.Size);
      }
    } else {
      add(info.size);
    }
    if (sizeless > 0) {
      log(
        "NOTICE",
        location,
        `Size may be underestimated due to ${sizeless} objects with unknown size`,
        flags,
      );
    }
    if (isTrue(flags.json)) {
      return new Response(`${JSON.stringify({ count, bytes, sizeless })}\n`);
    }
    const suffix = countString(count, true);
    let text = suffix === `${count}`
      ? `Total objects: ${count}\n`
      : `Total objects: ${suffix} (${count})\n`;
    text += `Total size: ${byteUnit(bytes)} (${bytes} Byte)\n`;
    if (sizeless > 0) {
      text += `Total objects with unknown size: ${
        countString(sizeless, true)
      } (${sizeless})\n`;
    }
    return new Response(text);
  } catch (error) {
    return failure(error);
  }
}

/**
 * Writes a size as `SizeSuffix.ByteUnit` of rclone, for example `11 B` or
 * `1.500 KiB`.
 * @param {number} bytes
 */
export function byteUnit(bytes) {
  const [, number, suffix] = sizeString(bytes, true).match(/^([\d.]+)(\D*)$/) ??
    [];
  return `${number} ${suffix}B`;
}
