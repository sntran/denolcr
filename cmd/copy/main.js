/**
 * The copy of files, as `rclone copy` and `rclone copyto`. `move` and
 * `moveto` use it too.
 *
 * A file goes when the target has no file with its name, or when the two
 * files differ, as rclone: another size, or another time. A time that a
 * backend does not give is not compared. The flags of rclone:
 *
 * - `--size-only`: compare only the sizes.
 * - `--ignore-times`: copy each file, also the same files.
 * - `--ignore-existing`: copy no file that the target has.
 * - `--create-empty-src-dirs`: make the folders with no file too.
 * - `--dry-run`: copy nothing, and tell what it would copy.
 * - `--transfers N`: copy N files at the same time, 4 by default.
 *
 * The backends do not keep the time of a source file yet: the time of a
 * copy is the time of the copy. Thus a second copy sends the files again,
 * unless `--size-only`.
 */
import { isTrue } from "@rfetch/lib/options";

import {
  copyFile,
  each,
  failure,
  folderOf,
  join,
  log,
  mkdir,
  nameOf,
  numberOf,
  OperationError,
  remove,
  stat,
  walk,
} from "../operations.js";

/**
 * Copy files from source to dest, skipping identical files, as `rclone
 * copy`. The contents of the source folder go in the dest folder. A source
 * file goes in the dest folder, with its name.
 *
 * ```js
 * import { copy } from "./main.js";
 * await copy("source:path", "dest:path");
 * ```
 * @param {string} source
 * @param {string} target
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function copy(source, target, flags = {}) {
  try {
    await transfer(source, target, flags);
    return new Response(null);
  } catch (error) {
    return failure(error);
  }
}

/**
 * Copy files from source to dest, skipping identical files, as `rclone
 * copyto`: a source file goes to the path of dest, with the name of dest.
 * A source folder is as `copy`.
 * @param {string} source
 * @param {string} target
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function copyto(source, target, flags = {}) {
  try {
    await transfer(source, target, flags, { to: true });
    return new Response(null);
  } catch (error) {
    return failure(error);
  }
}

/**
 * A file of a transfer.
 * @typedef {Object} File
 * @property {string} path The path from the folder of the transfer.
 * @property {string} location
 * @property {number} size
 * @property {string} modTime
 */

/**
 * Copies, or moves, a file or a folder.
 * @param {string} source
 * @param {string} target
 * @param {Object} flags
 * @param {{ move?: boolean, to?: boolean }} [mode] `move` deletes each source
 *   file after its copy. `to` puts a source file at the path of the target,
 *   not in the target folder.
 * @throws {OperationError}
 */
export async function transfer(source, target, flags, mode = {}) {
  const info = await stat(source, flags);
  if (!info) throw new OperationError("directory not found", 404);
  if (!info.isDir) {
    const location = mode.to ? target : join(target, nameOf(source));
    if (location === source) {
      throw new OperationError("can't copy or move a file onto itself", 400);
    }
    const existing = await stat(location, flags);
    await transferFile(
      {
        path: nameOf(location),
        location: source,
        size: info.size,
        modTime: info.modTime,
      },
      location,
      existing?.isDir ? null : existing,
      flags,
      mode,
    );
    return;
  }

  /** @type {File[]} */
  const files = [];
  /** @type {string[]} */
  const folders = [];
  for await (const item of await walk(source, flags)) {
    if (item.IsDir) folders.push(item.Path);
    else {
      files.push({
        path: item.Path,
        location: item.location,
        size: item.Size,
        modTime: item.ModTime,
      });
    }
  }
  /** @type {Map<string, import("../operations.js").WalkItem>} */
  const existing = new Map();
  try {
    for await (const item of await walk(target, flags)) {
      if (!item.IsDir) existing.set(item.Path, item);
    }
  } catch (error) {
    // A target that does not exist gets all the files.
    if (!(error instanceof OperationError && error.status === 404)) throw error;
  }

  if (isTrue(flags.create_empty_src_dirs) && !isTrue(flags.dry_run)) {
    await mkdir(target, flags);
    for (const path of folders) await mkdir(join(target, path, true), flags);
  }

  let errors = 0;
  let last = "";
  await each(files, numberOf(flags.transfers, 4), async (file) => {
    const other = existing.get(file.path);
    try {
      await transferFile(
        file,
        join(target, file.path),
        other
          ? { isDir: false, size: other.Size, modTime: other.ModTime }
          : null,
        flags,
        mode,
      );
    } catch (error) {
      errors++;
      last = error.message;
      log(
        "ERROR",
        file.path,
        `Failed to ${mode.move ? "move" : "copy"}: ${error.message}`,
        flags,
      );
    }
  });
  if (errors) {
    throw new OperationError(
      `failed to ${
        mode.move ? "move" : "copy"
      } ${errors} files: last error was: ${last}`,
    );
  }
  if (
    mode.move && isTrue(flags.delete_empty_src_dirs) && !isTrue(flags.dry_run)
  ) {
    await removeFolders(source, folders, flags);
  }
}

/**
 * Copies, or moves, a file, unless the target has the same file.
 * @param {File} file
 * @param {string} target The location of the target file.
 * @param {import("../operations.js").Info | null} existing The target file,
 *   or null.
 * @param {Object} flags
 * @param {{ move?: boolean }} mode
 */
async function transferFile(file, target, existing, flags, mode) {
  const verb = mode.move ? "move" : "copy";
  const same = existing && (isTrue(flags.ignore_existing) ||
    (!isTrue(flags.ignore_times) && isSame(file, existing, flags)));
  if (isTrue(flags.dry_run)) {
    if (!same || mode.move) {
      log(
        "NOTICE",
        file.path,
        `Skipped ${verb} as --dry-run is set (size ${file.size})`,
        flags,
      );
    }
    return;
  }
  if (!same) await copyFile(file.location, target, flags);
  // As rclone: a move deletes the source, also when the target has the same
  // file.
  if (mode.move) await remove(file.location, flags);
}

/**
 * Tells if two files are the same, as `Equal` of rclone: the same size, and
 * the same time in the precision of the two remotes. A time with no part of
 * a second comes from a remote with a precision of 1 s, as WebDAV: then the
 * times can differ by less than 1 s. Else they can differ by less than 1 ms.
 * A time that a backend does not give is not compared.
 * @param {{ size: number, modTime: string }} a
 * @param {{ size: number, modTime: string }} b
 * @param {Object} flags
 */
function isSame(a, b, flags) {
  if (a.size >= 0 && b.size >= 0 && a.size !== b.size) return false;
  if (isTrue(flags.size_only)) return true;
  const first = Date.parse(a.modTime);
  const second = Date.parse(b.modTime);
  if (isNaN(first) || isNaN(second)) return true;
  const fraction = /:\d\d\.\d/;
  const window = fraction.test(a.modTime) && fraction.test(b.modTime)
    ? 1
    : 1000;
  return Math.abs(first - second) < window;
}

/**
 * Deletes the folders of a source that have no file after a move, from the
 * deepest folder up. The folder of the source stays.
 * @param {string} source
 * @param {string[]} folders
 * @param {Object} flags
 */
async function removeFolders(source, folders, flags) {
  const deepest = folders.toSorted((a, b) =>
    b.split("/").length - a.split("/").length
  );
  for (const path of deepest) {
    const location = join(folderOf(source), path, true);
    // A folder with a file that did not move stays.
    let empty = true;
    for await (const _ of await walk(location, flags, { maxDepth: 1 })) {
      empty = false;
      break;
    }
    if (empty) await remove(location, flags);
  }
}
