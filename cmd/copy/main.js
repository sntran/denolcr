import { fetch } from "../../mod.js";
/**
 * Copy files from source to dest, skipping identical files.
 *
 * Copy the source to the destination. Does not transfer files that are
 * identical on source and destination, testing by size and modification time
 * or MD5SUM. Doesn't delete files from the destination. If you want to also
 * delete files from destination, to make it match source, use the `sync`
 * command instead.
 *
 * Note that it is always the contents of the directory that is synced, not
 * the directory itself. So when `source:path` is a directory, it's the
 * contents of source:path that are copied, not the directory name and
 * contents.
 *
 * To copy single files, use the `copyto` command instead.
 *
 * If `dest:path` doesn't exist, it is created and the source:path contents
 * go there.
 *
 * @param {string} source
 * @param {string} target
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function copy(source, target, flags) {
  /** @TODO: Handle copy folder */
  const params = new URLSearchParams(flags);
  const { body } = await fetch(`${source}?${params}`);
  return fetch(`${target}?${params}`, { method: "PUT", body });
}
