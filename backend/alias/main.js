/**
 * Alias remote
 *
 * The `alias` remote provides a new name for another remote.
 *
 * Paths may be as deep as required or a local path,
 * e.g. `remote:directory/subdirectory` or `/directory/subdirectory`.
 *
 * The target remote can either be a local path or another remote.
 *
 * Subfolders can be used in target remote. Assume an alias remote named
 * `backup` with the target `mydrive:private/backup`. Invoking
 * `rclone mkdir backup:desktop` is exactly the same as invoking
 * `rclone mkdir mydrive:private/backup/desktop`.
 *
 * There will be no special handling of paths containing `..` segments.
 * Invoking `rclone mkdir backup:../desktop` is exactly the same as invoking
 * `rclone mkdir mydrive:private/backup/../desktop`. The empty path is not
 * allowed as a remote. To alias the current directory use `.` instead.
 */

import { join } from "../../deps.js";
import { fetch } from "../../mod.js";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
function router(request) {
  const { pathname, searchParams } = new URL(request.url);
  const remote = searchParams.get("remote");

  if (!remote) {
    throw new Error("Missing remote");
  }

  // Delegates to the underlying remote.
  return fetch(join(remote, pathname), request);
}

export default {
  fetch: router,
};
