import { Options, Rclone } from "rclone";
/**
 * List the objects in the path with size and path.
 *
 * Lists the objects in the source path in a human readable format with size
 * and path. Recurses by default.
 *
 * Example:
 *
 * ```ts
 * import { Rclone } from "./mod.ts";
 * const response = await Rclone.ls("remote:path");
 * console.log(await response.text());
 * // 60295 bevajer5jef
 * // 90613 canole
 * // 94467 diwogej7
 * // 37600 fubuwic
 * ```
 */
export function ls(location: string, flags: Options = {}): Promise<Response> {
  flags = {
    recursive: "true",
    "max-depth": "Infinity",
    "files-only": "true",
    format: "sp",
    separator: "\t",
    ...flags,
  };
  return Rclone.lsf(location, flags);
}
