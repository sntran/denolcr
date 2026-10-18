import { isTrue } from "@rfetch/lib/options";
import { toListTime } from "@rfetch/lib/time";
import { LineStream, lsjson } from "../lsjson/main.js";

const FORMATS = {
  "p": "Path",
  "s": "Size",
  "t": "ModTime",
  "h": "Hash",
  "i": "ID",
  "o": "OrigID",
  "m": "MimeType",
  "e": "Encrypted",
  "T": "Tier",
  "M": "Metadata",
};

/**
 * List directories and objects in remote:path formatted for parsing.
 *
 * List the contents of the source path (directories and objects) in a form
 * which is easy to parse by scripts. By default this will just be the names of
 * the objects and directories, one per line. The directories will have a `/`
 * suffix.
 *
 * Example
 *
 * ```js
 * import { lsf } from "./main.js";
 * const response = await lsf("remote:path");
 * console.log(await response.text());
 * // bevajer5jef
 * // canole
 * // diwogej7
 * // ferejej3gux/
 * // fubuwic
 * ```
 *
 * Use the `--format` option to control what gets listed. By default this is
 * just the path, but you can use these parameters to control the output:
 *
 * ```
 * p - path
 * s - size
 * t - modification time
 * h - hash
 * i - ID of object
 * o - Original ID of underlying object
 * m - MimeType of object if known
 * e - encrypted name
 * T - tier of storage if known, e.g. "Hot" or "Cool"
 * M - Metadata of object in JSON blob format, eg {"key":"value"}
 * ```
 *
 * So if you wanted the path, size and modification time, you would use
 * `--format "pst"`, or maybe `--format "tsp"` to put the path last.
 *
 * Example:
 *
 * ```js
 * import { lsf } from "./main.js";
 * const response = await lsf("remote:path", { format: "tsp" });
 * console.log(await response.text());
 * // 2016-06-25 18:55:41;60295;bevajer5jef
 * // 2016-06-25 18:55:43;90613;canole
 * // 2016-06-25 18:55:43;94467;diwogej7
 * // 2018-04-26 08:50:45;0;ferejej3gux/
 * // 2016-06-25 18:55:40;37600;fubuwic
 * ```
 *
 * By default the separator is ";" this can be changed with the `--separator`
 * flag. Note that separators aren't escaped in the path so putting it last is
 * a good strategy.
 *
 * Example:
 *
 * ```js
 * import { lsf } from "./main.js";
 * const response = await lsf("remote:path", {
 *   separator: ",",
 *   format: "tshp",
 * });
 * console.log(await response.text());
 * // 2016-06-25 18:55:41,60295,7908e352297f0f530b84a756f188baa3,bevajer5jef
 * // 2016-06-25 18:55:43,90613,cd65ac234e6fea5925974a51cdd865cc,canole
 * // 2016-06-25 18:55:43,94467,03b5341b4f234b9d984d03ad076bae91,diwogej7
 * // 2018-04-26 08:52:53,0,,ferejej3gux/
 * // 2016-06-25 18:55:40,37600,8fd37c3810dd660778137ac3a66cc06d,fubuwic
 *
 * You can output in CSV standard format. This will escape things in `"` if
 * they contain `,`.
 *
 * Example:
 *
 * ```js
 * import { lsf } from "./main.js";
 * const response = await lsf("remote:path", {
 *   csv: true,
 *   files_only: true,
 *   format: "ps",
 * });
 * console.log(await response.text());
 * // test.log,22355
 * // test.sh,449
 * // "this file contains a comma, in the file name.txt",6
 * ```
 *
 * @param {string} location
 * @param {Object} [flags={}]
 * @param {boolean} [flags.csv=false] - Output in CSV format.
 * @param {boolean} [flags.dir_slash=true] - Append a slash to directory names.
 * @param {boolean} [flags.dirs_only=false] - Only list directories.
 * @param {boolean} [flags.files_only=false] - Only list files.
 * @param {string} [flags.format="p"] - Format of the listing.
 * @param {boolean} [flags.recursive=false] - Recurse into the listing.
 * @param {string} [flags.separator=";"] - Separator for the listing.
 * @returns {Promise<Response>}
 */
export async function lsf(location, flags = {}) {
  const format = flags.format ?? "p";
  const csv = isTrue(flags.csv);
  // As rclone, the separator of CSV is "," when the flag does not tell it.
  const separator = flags.separator ?? (csv ? "," : ";");
  const dirSlash = flags.dir_slash === undefined || isTrue(flags.dir_slash);
  const dirsOnly = isTrue(flags.dirs_only);
  const filesOnly = isTrue(flags.files_only);
  // CSV has a separator of one character.
  const comma = [...separator][0] ?? ",";

  const response = await lsjson(location, flags);
  if (!response.ok) return response;
  const lines = new LineStream((item) => {
    if (dirsOnly && !item.IsDir) return;
    if (filesOnly && item.IsDir) return;
    const values = [...format].map((letter) => {
      if (letter === "p") {
        return item.IsDir && dirSlash ? `${item.Path}/` : item.Path;
      }
      if (letter === "t") return toListTime(item.ModTime);
      const value = item[FORMATS[letter]] ?? "";
      return typeof value === "object" ? JSON.stringify(value) : `${value}`;
    });
    if (!csv) return values.join(separator);
    return values.map((value) => quoted(value, comma)).join(comma);
  });
  return new Response(response.body.pipeThrough(lines), {
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * Puts a value of CSV in quotes when it must have them, as `csv.Writer` of
 * Go: when it has the comma, a quote, a line break, or a space at the
 * start. A quote in the value becomes two quotes.
 * @param {string} value
 * @param {string} comma
 * @returns {string}
 */
function quoted(value, comma) {
  const needs = value === "\\." || value.includes(comma) ||
    /["\r\n]/.test(value) || SPACE.test(value);
  return needs ? `"${value.replaceAll('"', '""')}"` : value;
}

/** A space at the start of a text, as `unicode.IsSpace` of Go. */
const SPACE =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
