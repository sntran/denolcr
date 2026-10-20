import { isTrue } from "@rfetch/lib/options";

import { fetch } from "../../fetch.js";
import {
  failure,
  log,
  OperationError,
  stat,
  walk,
  withFlags,
} from "../operations.js";

/** The formats of `--timestamp`, as rclone. */
const TIMESTAMP = /^\d{4}-\d\d-\d\d(T\d\d:\d\d:\d\d(\.\d{1,9})?)?$/;

/**
 * Create new file or change file modification time, as `rclone touch`.
 *
 * A file that does not exist gets 0 bytes, unless `--no-create` or
 * `--recursive`. The backends cannot set the time of a file yet: thus a file
 * that exists, and `--timestamp`, give the error of rclone for a remote that
 * cannot set the time.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function touch(location, flags = {}) {
  try {
    const timestamp = flags.timestamp;
    if (timestamp !== undefined && !TIMESTAMP.test(`${timestamp}`)) {
      throw new OperationError(
        `failed to parse timestamp argument: ${timestamp}`,
        400,
      );
    }
    const info = await stat(location, flags);
    if (!info) {
      if (isTrue(flags.no_create)) {
        log(
          "NOTICE",
          location,
          "Not touching nonexistent file due to --no-create",
          flags,
        );
        return new Response(null);
      }
      if (isTrue(flags.recursive)) {
        log(
          "NOTICE",
          location,
          "Not touching nonexistent file due to --recursive",
          flags,
        );
        return new Response(null);
      }
      if (timestamp !== undefined) {
        throw new OperationError(
          "failed to touch (create): can't set modified time",
          501,
        );
      }
      if (isTrue(flags.dry_run)) {
        log(
          "NOTICE",
          location,
          "Skipped touch (create) as --dry-run is set",
          flags,
        );
        return new Response(null);
      }
      const response = await fetch(withFlags(location, flags), {
        method: "PUT",
        headers: { "Content-Length": "0" },
        body: new Uint8Array(0),
      });
      await response.body?.cancel();
      if (!response.ok) {
        throw new OperationError(
          `failed to touch (create): ${response.status} ${response.statusText}`
            .trim(),
          response.status,
        );
      }
      return new Response(null);
    }
    // The files of a folder, as rclone: with `--recursive`, also the files
    // of its folders.
    let files = info.isDir ? 0 : 1;
    if (info.isDir) {
      const depth = isTrue(flags.recursive) ? Infinity : 1;
      for await (
        const item of await walk(location, flags, { maxDepth: depth })
      ) {
        if (!item.IsDir) files++;
      }
    }
    if (files > 0 && !isTrue(flags.dry_run)) {
      throw new OperationError("failed to touch: can't set modified time", 501);
    }
    return new Response(null);
  } catch (error) {
    return failure(error);
  }
}
