import { File, lsjson, Options } from "../../main.ts";

const FORMATS: Record<string, string> = {
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
 * ```ts
 * import { lsf } from "./mod.ts";
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
 * ```ts
 * import { Rclone } from "./mod.ts";
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
 * ```ts
 * import { Rclone } from "./mod.ts";
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
 * ```ts
 * import { Rclone } from "./mod.ts";
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
 */
export async function lsf(
  location: string,
  flags: Options = {},
): Promise<Response> {
  const {
    csv = false,
    dir_slash: dirSlash = true,
    dirs_only: dirsOnly = false,
    files_only: filesOnly = false,
    format = "p",
    separator = ";",
  } = flags;

  const response = await lsjson(location, flags);
  const { headers, ok } = response;

  if (!ok) {
    return response;
  }

  const body = response.body!
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          // `lsjson returns each item on a new line, and except the
          // last line, all lines ends with a comma. We strip that
          // trailing comma and any new lines.
          chunk = chunk.trim().replace(/,$/, "");

          if (chunk.startsWith("{") && chunk.at(-1) === "}") {
            const item = JSON.parse(chunk) as File;
            if (dirsOnly && !item.IsDir) return;
            if (filesOnly && item.IsDir) return;

            if (item.IsDir && dirSlash) {
              item.Path += "/";
            }

            chunk = [...format].map((f) => {
              let value = item[FORMATS[f]];
              if (csv && typeof value === "string" && value.includes(",")) {
                value = `"${value}"`;
              }
              return value;
            }).join(separator);

            controller.enqueue(`${chunk}\n`);
          }
        },
      }),
    )
    .pipeThrough(new TextEncoderStream());

  return new Response(body, {
    headers: {
      ...headers,
      "Content-Type": "text/plain",
    },
  });
}
