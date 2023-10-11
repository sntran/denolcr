import { lsf, Options } from "../../main.ts";
/**
 * List the objects in the path with size and path.
 *
 * Lists the objects in the source path in a human readable format with size
 * and path. Recurses by default.
 *
 * Example:
 *
 * ```ts
 * import { ls } from "./mod.ts";
 * const response = await ls("remote:path");
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
    max_depth: "Infinity",
    files_only: "true",
    format: "sp",
    separator: "\t",
    ...flags,
  };
  return lsf(location, flags);
}
