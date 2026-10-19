/**
 * The operations that the commands share, as the package `operations` of
 * rclone: the information of a path, the files of a folder, the copy of a
 * file and the log of the messages.
 *
 * A location is a path of rclone for `fetch`, with percent-encoding, as the
 * command line gives it: for example `remote:a%20b/c.txt`.
 */
import process from "node:process";
import { isRemoteRoot, parse } from "@rfetch/lib/fspath";
import { readListing } from "@rfetch/lib/listing";
import { encodePath } from "@rfetch/lib/path";
import { formatUnixTime, nanosecondsOf } from "@rfetch/lib/time";

import { fetch } from "../fetch.js";
import { listItems } from "./lsjson/main.js";

/** The URL of a folder: the links of its list are relative to it. */
const FOLDER = new URL("http://remote/folder/");

/** The flags of the commands that are not options of a backend. */
const OWN_FLAGS = new Set(["recursive", "max_depth", "max-depth"]);

/**
 * An error of an operation, with the status of its answer: 404 for a folder
 * that does not exist, as the exit code 3 of rclone.
 */
export class OperationError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

/**
 * The answer of a command for an error.
 * @param {unknown} error
 * @returns {Response}
 */
export function failure(error) {
  if (error instanceof OperationError) {
    return new Response(error.message, { status: error.status });
  }
  if (error instanceof SyntaxError) {
    return new Response(error.message, { status: 400 });
  }
  throw error;
}

/**
 * Writes the messages of the commands on the standard error, as the log of
 * rclone: `2006/01/02 15:04:05 NOTICE: text`. The tests replace `write`.
 */
export const logger = {
  /** @param {string} line */
  write(line) {
    process.stderr.write(line);
  },
};

/**
 * Writes a message of a level, about an object, as rclone.
 * @param {"ERROR" | "NOTICE" | "INFO"} level
 * @param {string} object The object of the message, for example a path, or
 *   "".
 * @param {string} text
 * @param {Object} [flags] With `quiet`, only the errors.
 */
export function log(level, object, text, flags = {}) {
  if (level !== "ERROR" && (flags.quiet === true || flags.quiet === "true")) {
    return;
  }
  const now = new Date();
  const pad = (number) => `${number}`.padStart(2, "0");
  const time = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${
    pad(now.getDate())
  } ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  logger.write(
    `${time} ${level.padEnd(6)}: ${object ? `${object}: ` : ""}${text}\n`,
  );
}

/**
 * Gives a location with the flags of the command in its query, as the
 * other commands do: the fetch of rfetch gives each backend its flags.
 * @param {string} location
 * @param {Object} [flags]
 */
export function withFlags(location, flags = {}) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(flags)) {
    if (OWN_FLAGS.has(name)) continue;
    if (typeof value === "string" || typeof value === "boolean") {
      params.set(name, `${value}`);
    }
  }
  const query = `${params}`;
  return query ? `${location}?${query}` : location;
}

/**
 * Splits a location into its remote, and the path in the remote.
 * @param {string} location
 * @returns {{ remote: string, path: string }} For example `remote:` and
 *   `a/b.txt`.
 */
export function split(location) {
  const { path } = parse(location);
  return { remote: location.slice(0, location.length - path.length), path };
}

/**
 * Tells if a location is a folder by its form: the root of a remote, or a
 * path with `/` at the end.
 * @param {string} location
 */
export function isFolderForm(location) {
  const { path } = split(location);
  return path === "" || path.endsWith("/") || isRemoteRoot(path);
}

/**
 * Gives the location of a folder, with `/` at the end of its path.
 * @param {string} location
 */
export function folderOf(location) {
  const { path } = split(location);
  if (path === "" || path.endsWith("/")) return location;
  return `${location}/`;
}

/**
 * Gives the location of a path in a folder.
 * @param {string} folder The location of the folder.
 * @param {string} path A path with no percent-encoding, for example
 *   `a b/c.txt`.
 * @param {boolean} [isDir]
 */
export function join(folder, path, isDir = false) {
  return `${folderOf(folder)}${encodePath(path)}${isDir ? "/" : ""}`;
}

/**
 * The name of the last part of a location, with no percent-encoding.
 * @param {string} location
 */
export function nameOf(location) {
  const { path } = split(location);
  const name = path.replace(/\/$/, "").split("/").at(-1) ?? "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * The information of a file or a folder.
 * @typedef {Object} Info
 * @property {boolean} isDir
 * @property {number} size -1 for a folder.
 * @property {string} modTime The time in ISO 8601, or "".
 * @property {string} mimeType
 */

/**
 * Gives the information of a path, or null when it does not exist. As in
 * rclone, a path with no `/` at the end is a file, or else a folder.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Info | null>}
 * @throws {OperationError} When the remote gives an error.
 */
export async function stat(location, flags = {}) {
  if (isFolderForm(location)) {
    const response = await fetch(withFlags(folderOf(location), flags), {
      method: "HEAD",
    });
    await response.body?.cancel();
    if (response.ok) {
      return { isDir: true, size: -1, modTime: "", mimeType: "" };
    }
    if (response.status === 404) return null;
    throw new OperationError(
      `${location}: ${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }
  // The list of the folder tells if the name is a file or a folder.
  const { remote, path } = split(location);
  const slash = path.lastIndexOf("/") + 1;
  const parent = `${remote}${path.slice(0, slash)}`;
  const name = nameOf(location);
  const response = await fetch(withFlags(parent, flags));
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new OperationError(
      `${location}: ${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }
  const entries = (await readListing(response, FOLDER))
    .filter((entry) => entry.Name === name);
  const file = entries.find((entry) => !entry.IsDir);
  if (file) {
    return {
      isDir: false,
      size: file.Size,
      modTime: file.ModTime,
      mimeType: file.MimeType,
    };
  }
  if (entries.length) {
    return { isDir: true, size: -1, modTime: entries[0].ModTime, mimeType: "" };
  }
  return null;
}

/**
 * An item of a walk: a file or a folder below the folder of the walk.
 * @typedef {import("./lsjson/main.js").Item & { location: string }} WalkItem
 */

/**
 * Gives the files and the folders in a folder, and in its folders.
 * @param {string} location The location of the folder.
 * @param {Object} [flags]
 * @param {{ maxDepth?: number }} [options]
 * @returns {Promise<AsyncGenerator<WalkItem>>}
 * @throws {OperationError} With 404 when the folder does not exist.
 */
export async function walk(location, flags = {}, { maxDepth = Infinity } = {}) {
  const folder = folderOf(location);
  const items = await listItems(folder, {
    ...flags,
    recursive: "true",
    max_depth: String(maxDepth),
  });
  if (items instanceof Response) {
    const text = (await items.text()).trim();
    throw new OperationError(
      items.status === 404 ? "directory not found" : text ||
        `${items.status} ${items.statusText}`.trim(),
      items.status,
    );
  }
  return (async function* () {
    for await (const item of items) {
      yield { ...item, location: join(folder, item.Path, item.IsDir) };
    }
  })();
}

/**
 * Runs a function on each value, with `concurrency` at the same time.
 * @template T
 * @param {AsyncIterable<T> | Iterable<T>} values
 * @param {number} concurrency
 * @param {(value: T) => Promise<void>} run
 */
export async function each(values, concurrency, run) {
  const iterator = values[Symbol.asyncIterator]?.() ??
    values[Symbol.iterator]();
  const next = async () => {
    for (;;) {
      const { done, value } = await iterator.next();
      if (done) return;
      await run(value);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, next),
  );
}

/**
 * The number of a flag, or its default.
 * @param {unknown} value
 * @param {number} fallback
 */
export function numberOf(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * The statuses of a COPY or a MOVE that the backend cannot do: then the
 * bytes go through rfetch. 502 is for a destination in another remote.
 */
const CANNOT = new Set([403, 405, 501, 502]);

/**
 * Tells if a location is a URL, which goes to a server and not to a backend.
 * @param {string} location
 */
function isURL(location) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(location);
}

/**
 * The value of the header `X-OC-Mtime` for a time.
 * @param {string | undefined} modTime A time in ISO 8601.
 * @returns {Record<string, string>} The header, or no header for no time.
 */
function timeHeader(modTime) {
  const nanoseconds = nanosecondsOf(modTime);
  return nanoseconds === undefined
    ? {}
    : { "X-OC-Mtime": formatUnixTime(nanoseconds) };
}

/**
 * Copies or moves a file, and gives it the time of the source, as `Copy`
 * and `Move` of the operations of rclone. When the source and the target
 * are in the same remote, the backend copies or moves the file with COPY or
 * MOVE, and the bytes do not go through rfetch. Else, and for a backend that
 * cannot do it, rfetch reads the source and puts it at the target, then
 * deletes the source for a move.
 * @param {string} source
 * @param {string} target
 * @param {Object} [flags]
 * @param {{ modTime?: string, move?: boolean }} [options] `modTime` is the
 *   time of the source, in ISO 8601.
 * @throws {OperationError} When the copy or the move fails.
 */
export async function copyFile(
  source,
  target,
  flags = {},
  { modTime, move = false } = {},
) {
  const time = timeHeader(modTime);
  if (!isURL(source) && !isURL(target)) {
    for (const method of move ? ["MOVE", "COPY"] : ["COPY"]) {
      const response = await fetch(withFlags(source, flags), {
        method,
        headers: { Destination: withFlags(target, flags), ...time },
      });
      if (response.ok) {
        await response.body?.cancel();
        if (method === "COPY" && move) await remove(source, flags);
        return;
      }
      if (!CANNOT.has(response.status)) {
        const text = (await response.text()).trim();
        throw new OperationError(
          response.status === 404
            ? `${source}: not found`
            : `${target}: ${
              text || `${response.status} ${response.statusText}`.trim()
            }`,
          response.status,
        );
      }
      await response.body?.cancel();
      // Another remote: a COPY gives the same answer.
      if (response.status === 502) break;
    }
  }
  await putFile(source, target, flags, time);
  if (move) await remove(source, flags);
}

/**
 * Reads a file, and puts it at the target.
 * @param {string} source
 * @param {string} target
 * @param {Object} flags
 * @param {Record<string, string>} time The header of the time of the file.
 * @throws {OperationError} When the read or the write fails.
 */
async function putFile(source, target, flags, time) {
  const response = await fetch(withFlags(source, flags));
  if (!response.ok) {
    await response.body?.cancel();
    throw new OperationError(
      `${source}: ${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }
  /** @type {Record<string, string>} */
  const headers = { ...time };
  for (const name of ["Content-Type", "Content-Length"]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  const put = await fetch(withFlags(target, flags), {
    method: "PUT",
    headers,
    body: response.body ?? new Uint8Array(0),
  });
  if (!put.ok) {
    const text = (await put.text()).trim();
    throw new OperationError(
      `${target}: ${text || `${put.status} ${put.statusText}`.trim()}`,
      put.status,
    );
  }
  await put.body?.cancel();
}

/**
 * Moves a folder with all that is in it to a path that does not exist, with
 * a MOVE of the folder in the backend, as `DirMove` of rclone.
 * @param {string} source
 * @param {string} target
 * @param {Object} [flags]
 * @returns {Promise<boolean>} False when the backend cannot move the folder:
 *   then the caller moves each file.
 * @throws {OperationError} When the move fails.
 */
export async function moveFolder(source, target, flags = {}) {
  if (isURL(source) || isURL(target)) return false;
  const response = await fetch(withFlags(folderOf(source), flags), {
    method: "MOVE",
    headers: { Destination: withFlags(folderOf(target), flags) },
  });
  await response.body?.cancel();
  if (response.ok) return true;
  // 412: the target exists.
  if (CANNOT.has(response.status) || response.status === 412) return false;
  throw new OperationError(
    `${source}: ${response.status} ${response.statusText}`.trim(),
    response.status,
  );
}

/**
 * Sets the time of a file with PATCH, as `SetModTime` of rclone.
 * @param {string} location
 * @param {bigint} nanoseconds The time, in nanoseconds after 1970.
 * @param {Object} [flags]
 * @returns {Promise<boolean>} False when the backend cannot set the time.
 * @throws {OperationError} When the remote gives another error.
 */
export async function setModTime(location, nanoseconds, flags = {}) {
  const response = await fetch(withFlags(location, flags), {
    method: "PATCH",
    headers: { "X-OC-Mtime": formatUnixTime(nanoseconds) },
  });
  await response.body?.cancel();
  if (response.ok) return true;
  if (CANNOT.has(response.status)) return false;
  throw new OperationError(
    response.status === 404
      ? `${location}: not found`
      : `${location}: ${response.status} ${response.statusText}`.trim(),
    response.status,
  );
}

/**
 * Gives the `Last-Modified` of a file, from HEAD.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<string | null>}
 */
export async function lastModified(location, flags = {}) {
  const response = await fetch(withFlags(location, flags), { method: "HEAD" });
  await response.body?.cancel();
  return response.ok ? response.headers.get("Last-Modified") : null;
}

/**
 * Deletes a file, or a folder with all that is in it.
 * @param {string} location For a folder, with `/` at the end.
 * @param {Object} [flags]
 * @throws {OperationError} When the remote gives an error.
 */
export async function remove(location, flags = {}) {
  const response = await fetch(withFlags(location, flags), {
    method: "DELETE",
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new OperationError(
      response.status === 404
        ? `${location}: not found`
        : `${location}: ${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }
}

/**
 * Makes a folder, and the folders above it.
 * @param {string} location
 * @param {Object} [flags]
 * @throws {OperationError} When the remote gives an error.
 */
export async function mkdir(location, flags = {}) {
  const response = await fetch(withFlags(folderOf(location), flags), {
    method: "PUT",
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new OperationError(
      `${location}: ${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }
}

/**
 * Gives the type and the options of the remote of a location, from TRACE of
 * the fetch of rfetch: the options of the path, of the connection string,
 * of the flags, of the variables and of the config file.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<{ type: string, options: Record<string, string> }>}
 */
export async function remoteOf(location, flags = {}) {
  const response = await fetch(withFlags(location, flags), {
    method: "TRACE",
  });
  const [, type = ""] = response.headers.get("Via")?.match(/^(.*?)(\/.*)?$/) ??
    [];
  const lines = (await response.text()).split("\r");
  /** @type {Record<string, string>} */
  const options = {};
  const [, query = ""] = lines[0]?.match(/^TRACE [^?]*\?(.*) HTTP\/1\.1$/) ??
    [];
  for (const [name, value] of new URLSearchParams(query)) options[name] = value;
  // The other options are in the variables `RFETCH_TYPE_NAME`.
  const prefix = `RFETCH_${type.toUpperCase()}_`;
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(": ");
    if (colon === -1 || !line.startsWith(prefix)) continue;
    const name = line.slice(prefix.length, colon).toLowerCase();
    options[name] ??= line.slice(colon + 2);
  }
  return { type, options };
}
