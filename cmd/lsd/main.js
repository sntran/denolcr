import { lsf } from "../../mod.js";
/**
 * List all directories/containers/buckets in the path.
 *
 * Lists the directories in the source path. Does not recurse by default. Use
 * the `--recursive` flag to recurse.
 *
 * @param {string} location
 * @param {Object} [flags={}]
 * @param {boolean} [flags.recursive=false] - Only list directories.
 * @returns {Promise<Response>}
 */
export function lsd(location, flags = {}) {
  flags = {
    dirs_only: "true",
    format: "stp",
    recursive: "false",
    separator: "\t",
    ...flags,
  };
  return lsf(location, flags);
}
