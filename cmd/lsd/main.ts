import { Options, Rclone } from "rclone";
/**
 * List all directories/containers/buckets in the path.
 *
 * Lists the directories in the source path. Does not recurse by default. Use
 * the `--recursive` flag to recurse.
 */
export function lsd(location: string, flags: Options = {}): Promise<Response> {
  flags = {
    "dirs-only": "true",
    format: "stp",
    separator: "\t",
    ...flags,
  };
  return Rclone.lsf(location, flags);
}
