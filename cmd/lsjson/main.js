import { basename, HTMLRewriter, toLocaleISOString } from "../../deps.js";

import { fetch } from "../../mod.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * List directories and objects in the path in JSON format.
 *
 * The output is an array of Items, where each Item looks like this
 *
 * ```json
 * {
 *   "Hashes" : {
 *     "SHA-1" : "f572d396fae9206628714fb2ce00f72e94f2258f",
 *     "MD5" : "b1946ac92492d2347c6235b4d2611184",
 *     "DropboxHash" : "ecb65bb98f9d905b70458986c39fcbad7715e5f2fcc3b1f07767d7c83e2438cc"
 *   },
 *   "ID": "y2djkhiujf83u33",
 *   "OrigID": "UYOJVTUW00Q1RzTDA",
 *   "IsBucket" : false,
 *   "IsDir" : false,
 *   "MimeType" : "application/octet-stream",
 *   "ModTime" : "2017-05-31T16:15:57.034468261+01:00",
 *   "Name" : "file.txt",
 *   "Encrypted" : "v0qpsdq8anpci8n929v3uu9338",
 *   "EncryptedPath" : "kja9098349023498/v0qpsdq8anpci8n929v3uu9338",
 *   "Path" : "full/path/goes/here/file.txt",
 *   "Size" : 6,
 *   "Tier" : "hot",
 * }
 * ```
 *
 * The `Path` field will only show folders below the remote path being listed.
 * If "remote:path" contains the file "subfolder/file.txt", the `Path` for
 * "file.txt" will be "subfolder/file.txt", not "remote:path/subfolder/file.txt".
 * When used without `--recursive` the `Path` will always be same as `Name`.
 *
 * The whole output can be processed as a JSON blob, or alternatively it can be
 * processed line by line as each item is written one to a line.
 *
 * Note that `ls` and `lsl` recurse by default - use `--max-depth 1` to stop
 * the recursion.
 *
 * The other list commands `lsd`, `lsf`, `lsjson` do not recurse by default -
 * use `--recursive` to make them recurse.
 *
 * @param {string} location
 * @param {Object} [flags={}]
 * @param {number} [flags.max_depth=Infinity] - Maximum depth of recursion.
 * @param {boolean} [flags.recursive=false] - Recurse into the listing.
 * @returns {Promise<Response>}
 */
export async function lsjson(location, flags = {}) {
  const isDirectory = location.endsWith("/");
  const init = { method: "GET" };
  const segments = location.split("/");
  let filename;
  // If file, remove the last segment to query the parent directory.
  if (!isDirectory) {
    filename = segments.pop();
  }
  const params = new URLSearchParams(flags);
  const url = `${segments.join("/")}?${params}`;
  let response = await fetch(url, init);

  if (!response.ok) {
    return response;
  }

  let maxDepth = Number(flags.max_depth || (flags.recursive ? Infinity : 1));
  if (!isDirectory || !flags.recursive) {
    maxDepth = 1;
  }

  /**
   * A stream of JSON-encoded file objects, one per chunk/line.
   * Each JSON stringified line is followed by a comma and a newline.
   * Note: This stream does not wrap the output in an array.
   * @type {ReadableStream}
   */
  let body = new ReadableStream({
    start(controller) {
      /**
       * @type {import("../../mod.js").File}
       */
      let item;
      let transformed = Promise.resolve();
      /**
       * @type {Promise[]}
       */
      const promises = [];

      const rewriter = new HTMLRewriter();
      rewriter.on(`tbody`, {
        element(element) {
          element.onEndTag(() => {
            Promise.all(promises).then(() => {
              controller.close();
            });
          });
        },
      });
      rewriter.on(`tbody tr`, {
        element(element) {
          // Start a new item.
          item = {
            Path: "",
            Name: "",
            Size: -1,
            MimeType: "",
            ModTime: "",
            IsDir: true,
          };

          element.onEndTag(() => {
            if (item) {
              // We always enqueue the item with trailing comma.
              // Another transform will remove the trailing comma.
              const line = JSON.stringify(item) + ",\n";
              controller.enqueue(encoder.encode(line));
            }
          });
        },
      });
      // TODO: match only links relative to the current location
      rewriter.on(`tr a[href]`, {
        element(element) {
          const href = element.getAttribute("href");
          const { pathname } = new URL(href, "file:");

          if (pathname === "/") {
            item = null;
            return;
          }

          const name = basename(pathname);

          // If listing a file, skip other files.
          if (filename && name !== filename) {
            item = null;
            return;
          }

          item.Name = name;

          /**
           * The Path field will only show folders below the remote
           * path being listed. If "remote:path" contains the file
           * "subfolder/file.txt", the Path for "file.txt" will be
           * "subfolder/file.txt", not "remote:path/subfolder/file.txt".
           * When used without --recursive the Path will always be the
           * same as Name.
           */
          item.Path = name;

          const isDir = item.IsDir = pathname.endsWith("/");

          const type = element.getAttribute("type");
          if (type) {
            item.MimeType = type;
          }

          if (isDir) {
            item.MimeType = "inode/directory";
            item.Size = -1;

            // Recursively list subdirectories if --recursive
            if (maxDepth > 1) {
              // We don't want to block the current iteration, so we
              // start a new promise for each subdirectory using IIFE.
              // Inside, we await for the `done` promise to be resolved
              // before enqueueing the next item.
              const promise = (async () => {
                const response = await lsjson(`${location}${name}/`, {
                  ...flags,
                  max_depth: String(maxDepth - 1),
                });

                await response.body?.pipeThrough(
                  new TransformStream({
                    async transform(chunk) {
                      let line = decoder.decode(chunk).trim();

                      // skips the `[` line.
                      if (line === "[" || line === "]") {
                        return;
                      }

                      const child = JSON.parse(line.replace(/,$/, ""));
                      child.Path = `${name}/${child.Path}`;
                      line = JSON.stringify(child);

                      await transformed;
                      controller.enqueue(encoder.encode(line + ",\n"));
                    },
                  }),
                ).pipeTo(new WritableStream({}));
              })();
              promises.push(promise);
            }
          }
        },
      });
      rewriter.on(`tr data[value]`, {
        element(element) {
          if (!item) return;
          const value = element.getAttribute("value");
          item.Size = Number(value);
        },
      });
      rewriter.on(`tr time[datetime]`, {
        element(element) {
          if (!item) return;
          const value = element.getAttribute("datetime");
          if (value) {
            item.ModTime = toLocaleISOString(value);
          }
        },
      });

      response = rewriter.transform(response);
      transformed = response.body.pipeTo(new WritableStream());
    },
  });

  // Because the JSON objects always have trailing commas, we need to
  // do a transform to remove the trailing comma from the last object.
  /**
   * @type {Uint8Array}
   */
  let previousChunk;
  body = body.pipeThrough(
    new TransformStream({
      start(controller) {
        controller.enqueue(encoder.encode("[\n"));
      },
      // Because we want to detect the last chunk, we need to delay the
      // transform by one step, so we can handle it in `flush`.
      transform(chunk, controller) {
        if (previousChunk) {
          controller.enqueue(previousChunk);
        }
        previousChunk = chunk;
      },
      flush(controller) {
        if (previousChunk) {
          const chunk = concat(
            previousChunk.slice(0, -2),
            encoder.encode("\n"),
          );
          controller.enqueue(chunk);
        }
        controller.enqueue(encoder.encode("]\n"));
      },
    }),
  );

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Concats two Uint8Arrays
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {Uint8Array}
 */
function concat(a, b) {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}
