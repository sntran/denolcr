import { isTrue } from "@rfetch/lib/options";
import { formatUnixTime } from "@rfetch/lib/time";

import { fetch } from "../../fetch.js";
import {
  failure,
  log,
  OperationError,
  setModTime,
  stat,
  walk,
  withFlags,
} from "../operations.js";

/**
 * The formats of `--timestamp`, as rclone: the format comes from the length
 * of the text.
 */
const SHORT = /^(\d\d)(\d\d)(\d\d)$/;
const LONG = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?$/;

/**
 * Create new file or change file modification time, as `rclone touch`.
 *
 * The time is now, or the time of `--timestamp`: `YYMMDD`, for example
 * `060102`, `2006-01-02T15:04:05` or `2006-01-02T15:04:05.123456789`, in
 * UTC, or in the local time with `--localtime`.
 *
 * A file that does not exist gets 0 bytes and the time, unless `--no-create`
 * or `--recursive`. A file that exists gets the time with PATCH. For a
 * folder, each file in it gets the time, and with `--recursive`, each file
 * in its folders too. A backend that cannot set the time of a file gives the
 * error of rclone.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function touch(location, flags = {}) {
  try {
    const time = timeOf(flags);
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
      if (isTrue(flags.dry_run)) {
        log(
          "NOTICE",
          location,
          "Skipped touch (create) as --dry-run is set",
          flags,
        );
        return new Response(null);
      }
      // As rclone, a backend that cannot keep the time keeps the file.
      const response = await fetch(withFlags(location, flags), {
        method: "PUT",
        headers: {
          "Content-Length": "0",
          "X-OC-Mtime": formatUnixTime(time),
        },
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
    if (!info.isDir) {
      if (isTrue(flags.dry_run)) {
        log("NOTICE", location, "Skipped touch as --dry-run is set", flags);
      } else if (!await setModTime(location, time, flags)) {
        throw new OperationError(
          "failed to touch: can't set modified time",
          501,
        );
      }
      return new Response(null);
    }
    // The files of a folder, as rclone: with `--recursive`, also the files
    // of its folders.
    const depth = isTrue(flags.recursive) ? Infinity : 1;
    let errors = 0;
    for await (
      const item of await walk(location, flags, { maxDepth: depth })
    ) {
      if (item.IsDir) continue;
      if (isTrue(flags.dry_run)) {
        log("NOTICE", item.Path, "Skipped touch as --dry-run is set", flags);
      } else if (!await setModTime(item.location, time, flags)) {
        errors++;
        log(
          "ERROR",
          item.Path,
          "failed to touch: can't set modified time",
          flags,
        );
      }
    }
    if (errors) {
      throw new OperationError(
        `failed to touch ${errors} files: can't set modified time`,
        501,
      );
    }
    return new Response(null);
  } catch (error) {
    return failure(error);
  }
}

/**
 * The time of the touch: now, or the time of `--timestamp`.
 * @param {Object} flags
 * @returns {bigint} The nanoseconds after 1970.
 * @throws {OperationError} For a timestamp that is not correct.
 */
function timeOf(flags) {
  const timestamp = flags.timestamp;
  if (timestamp === undefined || timestamp === "") {
    return BigInt(Date.now()) * 1000000n;
  }
  const text = `${timestamp}`;
  const fail = () =>
    new OperationError(`failed to parse timestamp argument: ${text}`, 400);
  /** @type {number[]} */
  let fields;
  let fraction = "";
  if (text.length < 19) {
    // `060102` of Go: a year of two digits from 1969 to 2068.
    const match = SHORT.exec(text);
    if (!match) throw fail();
    const year = Number(match[1]);
    fields = [
      year >= 69 ? 1900 + year : 2000 + year,
      ...[2, 3].map((i) => Number(match[i])),
      0,
      0,
      0,
    ];
  } else {
    const match = LONG.exec(text);
    // A text of 19 characters has no part of a second, and a longer text
    // has one.
    if (!match || (text.length > 19) !== (match[7] !== undefined)) {
      throw fail();
    }
    fields = match.slice(1, 7).map(Number);
    fraction = match[7] ?? "";
  }
  const milliseconds = isTrue(flags.localtime)
    ? new Date(
      fields[0],
      fields[1] - 1,
      fields[2],
      fields[3],
      fields[4],
      fields[5],
    ).getTime()
    : Date.UTC(
      fields[0],
      fields[1] - 1,
      fields[2],
      fields[3],
      fields[4],
      fields[5],
    );
  // As Go, a field out of its range is an error.
  const date = new Date(milliseconds);
  const check = isTrue(flags.localtime)
    ? [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()]
    : [
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCHours(),
    ];
  if (
    isNaN(milliseconds) || check.some((value, i) => value !== fields[i]) ||
    fields[4] > 59 || fields[5] > 59
  ) {
    throw fail();
  }
  return BigInt(milliseconds) * 1000000n + BigInt(fraction.padEnd(9, "0"));
}
