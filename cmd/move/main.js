import { failure } from "../operations.js";
import { transfer } from "../copy/main.js";

/**
 * Move files from source to dest, as `rclone move`: the copy of `copy`,
 * then the delete of each source file. The folders of the source stay,
 * unless `--delete-empty-src-dirs`.
 *
 * The backends cannot move a file yet: each file goes through rfetch.
 *
 * ```js
 * import { move } from "./main.js";
 * await move("source:path", "dest:path");
 * ```
 * @param {string} source
 * @param {string} target
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function move(source, target, flags = {}) {
  try {
    await transfer(source, target, flags, { move: true });
    return new Response(null);
  } catch (error) {
    return failure(error);
  }
}

/**
 * Move file or directory from source to dest, as `rclone moveto`: a source
 * file goes to the path of dest, with the name of dest. A source folder is
 * as `move`.
 * @param {string} source
 * @param {string} target
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function moveto(source, target, flags = {}) {
  try {
    await transfer(source, target, flags, { move: true, to: true });
    return new Response(null);
  } catch (error) {
    return failure(error);
  }
}
