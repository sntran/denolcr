/**
 * The commands that delete, as rclone: `delete`, `deletefile`, `purge`,
 * `rmdir` and `rmdirs`. With `--dry-run`, they delete nothing, and tell
 * what they would delete.
 */
import { isTrue } from "@rfetch/lib/options";

import { fetch } from "../../fetch.js";
import {
  each,
  failure,
  folderOf,
  log,
  numberOf,
  OperationError,
  remove,
  stat,
  walk,
  withFlags,
} from "../operations.js";

/**
 * Remove the files in the path, as `rclone delete`. The folders stay, unless
 * `--rmdirs`: then the folders with no file go too, but not the folder of the
 * path. A path of a file deletes only that file.
 *
 * ```js
 * import { delete as remove } from "./main.js";
 * await remove("remote:path", { rmdirs: true });
 * ```
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
async function deleteFiles(location, flags = {}) {
  try {
    const info = await stat(location, flags);
    if (!info) throw new OperationError("directory not found", 404);
    if (!info.isDir) {
      await deleteOne(location, location, info.size, flags);
      return new Response(null);
    }
    const files = [];
    for await (const item of await walk(location, flags)) {
      if (!item.IsDir) files.push(item);
    }
    let errors = 0;
    let last = "";
    await each(files, numberOf(flags.checkers, 8), async (item) => {
      try {
        await deleteOne(item.location, item.Path, item.Size, flags);
      } catch (error) {
        errors++;
        last = error.message;
        log("ERROR", item.Path, `Couldn't delete: ${error.message}`, flags);
      }
    });
    if (errors) {
      throw new OperationError(
        `failed to delete ${errors} files: last error was: ${last}`,
      );
    }
    if (isTrue(flags.rmdirs)) {
      await removeEmptyFolders(location, flags, true);
    }
    return new Response(null);
  } catch (error) {
    return failure(error);
  }
}

export { deleteFiles as delete };

/**
 * Deletes a file, or tells it with `--dry-run`.
 * @param {string} location
 * @param {string} name The name for the log.
 * @param {number} size
 * @param {Object} flags
 */
async function deleteOne(location, name, size, flags) {
  if (isTrue(flags.dry_run)) {
    log(
      "NOTICE",
      name,
      `Skipped delete as --dry-run is set (size ${size})`,
      flags,
    );
    return;
  }
  await remove(location, flags);
}

/**
 * Remove a single file from remote, as `rclone deletefile`. A folder, or a
 * path that does not exist, is an error.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function deletefile(location, flags = {}) {
  try {
    const info = await stat(location, flags);
    if (!info || info.isDir) {
      throw new OperationError(
        `${location} is a directory or doesn't exist: object not found`,
        404,
      );
    }
    await deleteOne(location, location, info.size, flags);
    return new Response(null);
  } catch (error) {
    return failure(error);
  }
}

/**
 * Remove the path and all of its contents, as `rclone purge`.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function purge(location, flags = {}) {
  try {
    const info = await stat(location, flags);
    if (!info) throw new OperationError("directory not found", 404);
    if (!info.isDir) {
      throw new OperationError(`${location} is a file not a directory`, 400);
    }
    if (isTrue(flags.dry_run)) {
      log("NOTICE", location, "Skipped purge as --dry-run is set", flags);
    } else {
      await remove(folderOf(location), flags);
    }
    return new Response(null);
  } catch (error) {
    return failure(error);
  }
}

/**
 * Remove the empty folder of the path, as `rclone rmdir`. A folder with a
 * file or a folder in it is an error.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function rmdir(location, flags = {}) {
  try {
    const folder = folderOf(location);
    const response = await fetch(withFlags(folder, flags));
    if (response.status === 404) {
      await response.body?.cancel();
      throw new OperationError(`${location}: directory not found`, 404);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OperationError(
        `${location}: ${response.status} ${response.statusText}`.trim(),
        response.status,
      );
    }
    await response.body?.cancel();
    for await (const _ of await walk(folder, flags, { maxDepth: 1 })) {
      throw new OperationError(`remove ${location}: directory not empty`, 409);
    }
    if (isTrue(flags.dry_run)) {
      log(
        "NOTICE",
        location,
        "Skipped remove directory as --dry-run is set",
        flags,
      );
    } else {
      await remove(folder, flags);
    }
    return new Response(null);
  } catch (error) {
    return failure(error);
  }
}

/**
 * Remove the folders with no file in the path, as `rclone rmdirs`: a folder
 * with only folders that have no file goes too. The folder of the path goes
 * when it has no file, unless `--leave-root`. The backends delete a folder
 * with all that is in it: thus a file that comes into such a folder during
 * the command goes with the folder.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function rmdirs(location, flags = {}) {
  try {
    await removeEmptyFolders(location, flags, isTrue(flags.leave_root));
    return new Response(null);
  } catch (error) {
    return failure(error);
  }
}

/**
 * Deletes the folders with no file in a folder.
 * @param {string} location
 * @param {Object} flags
 * @param {boolean} leaveRoot When true, the folder of the location stays.
 */
async function removeEmptyFolders(location, flags, leaveRoot) {
  /** @type {Map<string, string>} The locations of the folders, by path. */
  const folders = new Map();
  /** The folders with a file in them, also below. */
  const full = new Set([""]);
  let hasFile = false;
  for await (const item of await walk(location, flags)) {
    if (item.IsDir) {
      folders.set(item.Path, item.location);
      continue;
    }
    hasFile = true;
    const names = item.Path.split("/");
    for (let i = 1; i < names.length; i++) {
      full.add(names.slice(0, i).join("/"));
    }
  }
  const dryRun = isTrue(flags.dry_run);
  if (!hasFile && !leaveRoot) {
    if (dryRun) {
      log(
        "NOTICE",
        location,
        "Skipped remove directory as --dry-run is set",
        flags,
      );
    } else {
      await remove(folderOf(location), flags);
    }
    return;
  }
  // The highest folders with no file: the delete of a folder deletes the
  // folders in it.
  for (const [path, folder] of [...folders].sort()) {
    if (full.has(path)) continue;
    const parent = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : "";
    if (!full.has(parent)) continue;
    if (dryRun) {
      log(
        "NOTICE",
        path,
        "Skipped remove directory as --dry-run is set",
        flags,
      );
    } else {
      await remove(folder, flags);
    }
  }
}
