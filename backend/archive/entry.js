/**
 * The parts that the readers of archives share: the entries, the errors,
 * the check of the names, and the check of the data.
 */
import { crc32 } from "@rfetch/lib/crc32";

/**
 * A file or a folder in an archive.
 * @typedef {Object} Entry
 * @property {string} path The path in the archive, with no `/` at the start
 *   or at the end, for example `folder/file.txt`.
 * @property {boolean} isDir
 * @property {number} size The size of the file, before the compression.
 * @property {string} modTime The time of the last change, in ISO 8601, or
 *   "" for no time.
 * @property {(range: { start: number, end: number } | null) =>
 *   Promise<ReadableStream<Uint8Array>>} open Gives the bytes of the file,
 *   or of a range of the file. The stream gives an error at its end when
 *   the data are not correct.
 */

/**
 * An archive that rfetch cannot read, with the status of the answer: 500
 * for an archive that is not correct, 501 for a feature that rfetch does
 * not support, for example a compression method.
 */
export class ArchiveError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

/**
 * The path of a name of an archive, as `sanitize.Path` of rclone: with no
 * `.` or empty part, and no `/` at the start or at the end.
 * @param {string} name The name in the archive, with `/` between folders.
 * @returns {string | null} Null for a name that goes out of the archive
 *   (a part `..`, also with `\`), or that rfetch cannot read in a URL (a
 *   NUL character). "" for the root of the archive.
 */
export function cleanPath(name) {
  if (name.split(/[/\\]/).includes("..") || name.includes("\0")) return null;
  return name.split("/").filter((part) => part !== "" && part !== ".")
    .join("/");
}

/**
 * A stream that counts the bytes of a file and makes their CRC-32. At the
 * end, it gives an error when the size or the CRC-32 is not the one of the
 * archive.
 * @param {{ size: number, crc: number | null, format: string }} expected
 *   No check of the CRC-32 when `crc` is null.
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function checkStream({ size, crc, format }) {
  let count = 0;
  let value = 0;
  return new TransformStream({
    transform(chunk, controller) {
      count += chunk.length;
      if (count > size) {
        throw new ArchiveError(`${format}: the file is larger than its size`);
      }
      if (crc !== null) value = crc32(chunk, value);
      controller.enqueue(chunk);
    },
    flush() {
      if (count !== size) throw new ArchiveError(`${format}: unexpected EOF`);
      if (crc !== null && value !== crc) {
        throw new ArchiveError(`${format}: checksum error`);
      }
    },
  });
}

/**
 * The time of an archive in ISO 8601, to the second: the precision of the
 * archive remote of rclone. The archive formats keep 1 s or 2 s, and
 * rclone also gives a time of NTFS to the second.
 * @param {number} milliseconds The time after 1970, in ms.
 */
export function isoTime(milliseconds) {
  const date = new Date(Math.floor(milliseconds / 1000) * 1000);
  if (isNaN(date.getTime())) return "";
  return `${date.toISOString().slice(0, 19)}Z`;
}
