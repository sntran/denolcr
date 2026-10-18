import { parse } from "@rfetch/lib/fspath";
import { readListing } from "@rfetch/lib/listing";
import { isTrue } from "@rfetch/lib/options";
import { DEFAULT_TIME, toLocaleISOString } from "@rfetch/lib/time";

import { fetch } from "../../fetch.js";

const encoder = new TextEncoder();

/** The URL of a folder: the links of its list are relative to it. */
const FOLDER = new URL("http://remote/folder/");

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
 * @param {RequestInit} [init] The init of each request of the list, for
 *   example the headers with the options `RFETCH_*`.
 * @returns {Promise<Response>}
 */
export async function lsjson(location, flags = {}, init = {}) {
  // A path that ends with `.` or `..` is a folder, as in rclone.
  if (/(^|[:/])\.\.?$/.test(location)) location = `${location}/`;
  // Only the path in the remote has folders: a value of the connection
  // string can have a "/" too, for example `:crypt,remote='a/b':path`.
  const parsed = parse(location);
  const prefix = location.slice(0, location.length - parsed.path.length);
  const path = parsed.path;
  const isDirectory = path === "" || path.endsWith("/");
  init = { ...init, method: "GET" };
  let folder = path;
  let filename;
  // If file, list the parent directory and keep only the file.
  if (!isDirectory) {
    const slash = path.lastIndexOf("/") + 1;
    folder = path.slice(0, slash);
    filename = nameOf(path.slice(slash));
  }
  const params = new URLSearchParams(flags);
  const url = `${prefix}${folder}?${params}`;
  const response = await fetch(url, init);

  if (!response.ok) {
    return response;
  }

  /** @type {import("@rfetch/lib/listing").Entry[] | undefined} */
  let entries;
  if (!isDirectory) {
    // A path with no "/" at the end is a folder when no file has the name,
    // as in rclone: then the list is the list of the folder.
    entries = await readListing(response, FOLDER);
    const named = entries.filter(({ Name }) => Name === filename);
    // As rclone, a path that names no file and no folder is not found.
    if (named.length === 0) {
      return new Response("directory not found", { status: 404 });
    }
    if (named.every(({ IsDir }) => IsDir)) {
      return lsjson(`${location}/`, flags, init);
    }
  }

  const recursive = isTrue(flags.recursive);
  let maxDepth = Number(flags.max_depth || (recursive ? Infinity : 1));
  if (!isDirectory || !recursive) {
    maxDepth = 1;
  }

  /** @type {Walk} */
  const options = { location, depth: maxDepth, flags, init, filename };
  const listed = entries
    ? Promise.resolve(folderOf(entries, options))
    : readListing(response, FOLDER).then((list) => folderOf(list, options));
  // The error comes when the stream gets to the folder.
  listed.catch(() => {});
  const items = walk(listed, "");

  /**
   * The JSON of the item before, with no comma: only the last item has no
   * comma after it.
   * @type {string | null}
   */
  let previous = null;

  /**
   * A stream of JSON-encoded file objects, one per chunk and line, in an
   * array.
   * @type {ReadableStream<Uint8Array>}
   */
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("[\n"));
    },
    async pull(controller) {
      for (;;) {
        const { done, value } = await items.next();
        if (done) {
          if (previous !== null) {
            controller.enqueue(encoder.encode(`${previous}\n`));
          }
          controller.enqueue(encoder.encode("]\n"));
          controller.close();
          return;
        }
        const line = JSON.stringify(value);
        if (previous !== null) {
          controller.enqueue(encoder.encode(`${previous},\n`));
          previous = line;
          return;
        }
        previous = line;
      }
    },
    async cancel() {
      await items.return(undefined);
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * An item of the output of `lsjson`.
 * @typedef {Object} Item
 * @property {string} Path The path below the listed folder.
 * @property {string} Name
 * @property {number} Size
 * @property {string} MimeType
 * @property {string | undefined} ModTime
 * @property {boolean} IsDir
 */

/**
 * The list of a folder: its items, and the lists of its folders.
 * @typedef {Object} Folder
 * @property {Item[]} items
 * @property {{ name: string, folder: Promise<Folder> }[]} folders
 */

/**
 * @typedef {Object} Walk
 * @property {string} location The location of the folder, with a `/` at the
 *   end.
 * @property {number} depth The levels to list: 1 is only this folder.
 * @property {Object} flags
 * @property {RequestInit} init
 * @property {string} [filename] When set, only the file with this name.
 */

/**
 * Gives the folder of the entries of its list. When `depth` is more than 1,
 * it starts to read the lists of the folders in it at once, thus the
 * requests go at the same time.
 * @param {import("@rfetch/lib/listing").Entry[]} entries
 * @param {Walk} options
 * @returns {Folder}
 */
function folderOf(entries, { location, depth, flags, init, filename }) {
  /** @type {Folder} */
  const result = { items: [], folders: [] };
  for (const { Name, IsDir, Size, MimeType, ModTime } of entries) {
    // If listing a file, skip other files.
    if (filename && Name !== filename) continue;
    result.items.push({
      Path: Name,
      Name,
      Size,
      MimeType: IsDir ? "inode/directory" : MimeType,
      // A folder with no time has the default time of rclone.
      ModTime: ModTime ? toLocaleISOString(ModTime) : IsDir ? DEFAULT_TIME : "",
      IsDir,
    });
    if (IsDir && depth > 1) {
      // The name of the folder in the path has percent-encoding, else a "?"
      // or a "#" in the name starts a query.
      const child = `${location}${encodeURIComponent(Name)}/`;
      const folder = list(Name, {
        location: child,
        depth: depth - 1,
        flags: { ...flags, max_depth: String(depth - 1) },
        init,
      });
      // The error comes when the walk gets to this folder.
      folder.catch(() => {});
      result.folders.push({ name: Name, folder });
    }
  }
  return result;
}

/**
 * Requests the list of a folder, and reads it.
 * @param {string} name The name of the folder, for the error.
 * @param {Walk} options
 * @returns {Promise<Folder>}
 */
async function list(name, options) {
  const params = new URLSearchParams(options.flags);
  const response = await fetch(`${options.location}?${params}`, options.init);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Cannot list ${name}: ${response.status}`);
  }
  return folderOf(await readListing(response, FOLDER), options);
}

/**
 * Gives the items of a folder, then the items of each folder in it. The
 * `Path` of an item has the names of the folders above it, below the listed
 * folder.
 * @param {Promise<Folder>} folder
 * @param {string} path The path of the folder, or "" for the listed folder.
 * @returns {AsyncGenerator<Item>}
 */
async function* walk(folder, path) {
  const { items, folders } = await folder;
  for (const item of items) {
    if (path) item.Path = `${path}/${item.Path}`;
    yield item;
  }
  for (const { name, folder } of folders) {
    yield* walk(folder, path ? `${path}/${name}` : name);
  }
}

/**
 * A stream that reads the body of `lsjson`, in chunks of any size, and gives
 * the body of a list of text: a line for each item. It keeps only the part of
 * a line that has no "\n" yet. The lists of text `ls`, `lsl`, `lsd` and `lsf`
 * use it.
 *
 * Example
 *
 * ```js
 * import { LineStream, lsjson } from "./main.js";
 * const response = await lsjson("remote:path");
 * const paths = response.body.pipeThrough(
 *   new LineStream((item) => item.Path),
 * );
 * ```
 * @extends {TransformStream<Uint8Array, Uint8Array>}
 */
export class LineStream extends TransformStream {
  /**
   * @param {(item: Item) => string | undefined} line Gives the line of an
   *   item, with no line break, or no line.
   */
  constructor(line) {
    const decoder = new TextDecoder();
    let rest = "";
    /**
     * Writes the lines of the items of the lines of `lsjson`.
     * @param {string[]} texts
     * @param {TransformStreamDefaultController<Uint8Array>} controller
     */
    const write = (texts, controller) => {
      let lines = "";
      for (let text of texts) {
        // `lsjson` gives each item on a line, with a comma at the end of
        // each line but the last.
        text = text.trim().replace(/,$/, "");
        if (!text.startsWith("{")) continue;
        const value = line(JSON.parse(text));
        if (value !== undefined) lines += `${value}\n`;
      }
      if (lines) controller.enqueue(encoder.encode(lines));
    };
    super({
      transform(chunk, controller) {
        const texts = (rest + decoder.decode(chunk, { stream: true }))
          .split("\n");
        rest = texts.pop() ?? "";
        write(texts, controller);
      },
      flush(controller) {
        write([rest + decoder.decode()], controller);
      },
    });
  }
}

/**
 * The name of a file in the path of a location, as a backend reads it: with
 * no percent-encoding.
 * @param {string} segment For example `a%20b.txt` or `a b.txt`.
 * @returns {string}
 */
function nameOf(segment) {
  const { pathname } = new URL(segment, "file:///");
  try {
    return decodeURIComponent(pathname.slice(1));
  } catch {
    return pathname.slice(1);
  }
}
