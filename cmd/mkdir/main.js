import { failure, mkdir as makeFolder } from "../operations.js";

/**
 * Make the path if it doesn't already exist, as `rclone mkdir`. The folders
 * above the path come too.
 *
 * ```js
 * import { mkdir } from "./main.js";
 * await mkdir("remote:path/to/folder");
 * ```
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function mkdir(location, flags = {}) {
  try {
    await makeFolder(location, flags);
    return new Response(null);
  } catch (error) {
    return failure(error);
  }
}
