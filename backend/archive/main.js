/**
 * Archive remote
 *
 * The `archive` remote reads the files in the archives of another remote,
 * as the archive backend of rclone, with no download of all the archive.
 * Each archive is a folder, and each file in it can be read alone, also a
 * range of it. The files in an archive are read only. The other files of
 * the remote can be read and written as normal.
 *
 * As rclone, the remote is best used with no configuration: put
 * `:archive:` before the path of another remote, for example
 * `:archive:s3:bucket/folder/`. Then `files.zip` in that folder is the
 * folder `files.zip/`. The option `remote` can also tell the remote, for
 * example `s3:bucket/folder/files.zip`.
 *
 * The archives are known by their names:
 *
 * - zip: `.zip`, as rclone, and the formats that are zip files, for example
 *   `.docx`, `.xlsx`, `.epub`, `.jar` and `.kmz`. rclone knows only `.zip`.
 *   The methods are Store and Deflate, as rclone.
 *
 * An archive is read again for each request: rfetch keeps no data between
 * requests. The time of a folder that is not in the index of a zip file is
 * the time of the request, as rclone.
 */
import { readListing, renderListing } from "@rfetch/lib/listing";
import { mimeType } from "@rfetch/lib/mime";
import { optionsOf, remoteHeaders } from "@rfetch/lib/options";
import { decodePath, encodePath } from "@rfetch/lib/path";
import { notSatisfiable, parseRange, partialHeaders } from "@rfetch/lib/range";
import { RangedFile, RemoteError } from "@rfetch/lib/ranged";
import { parse } from "@rfetch/lib/fspath";
import { sized } from "@rfetch/lib/sized";

import { ArchiveError } from "./entry.js";
import { openZip } from "./zip.js";

/**
 * The options of the backend, with their types, for example for the flag
 * `--archive-remote` of the command line.
 */
export const options = {
  string: ["remote"],
};

/** The formats that are zip files, by the extension of their names. */
const ZIP = [
  ".zip",
  // Office Open XML.
  ".docx",
  ".docm",
  ".dotx",
  ".dotm",
  ".xlsx",
  ".xlsm",
  ".xltx",
  ".xltm",
  ".xlsb",
  ".pptx",
  ".pptm",
  ".potx",
  ".potm",
  ".ppsx",
  ".ppsm",
  ".vsdx",
  // OpenDocument.
  ".odt",
  ".ods",
  ".odp",
  ".odg",
  ".odf",
  ".ott",
  ".ots",
  ".otp",
  // Books, maps, packages and models.
  ".epub",
  ".cbz",
  ".kmz",
  ".jar",
  ".war",
  ".ear",
  ".aar",
  ".apk",
  ".aab",
  ".ipa",
  ".xpi",
  ".whl",
  ".nupkg",
  ".vsix",
  ".appx",
  ".msix",
  ".3mf",
  ".usdz",
];

/**
 * The readers of the archives, by the extension of their names. As
 * rclone, the extension is in lower case.
 * @type {Map<string, (file: RangedFile) =>
 *   Promise<import("./entry.js").Entry[]>>}
 */
const FORMATS = new Map(ZIP.map((extension) => [extension, openZip]));

/**
 * The reader of an archive from its name, or undefined for a name that is
 * not an archive.
 * @param {string} name
 */
export function formatOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? undefined : FORMATS.get(name.slice(dot));
}

/**
 * Splits a path of rclone at its first archive.
 * @param {string} text A path of rclone, for example
 *   `s3:bucket/files.zip/folder/`.
 * @returns {{
 *   location: string,
 *   inner: string | null,
 *   open?: (file: RangedFile) => Promise<import("./entry.js").Entry[]>,
 * }} `location` is the location for `fetch` of the archive, or of the path
 * when it has no archive. `inner` is the path in the archive, "" for its
 * root, with a "/" at the end for a folder. It is null for a path that is
 * not in an archive.
 * @throws {SyntaxError} When the path is not correct.
 */
export function locate(text) {
  const { name, configString, path } = parse(text);
  const head = name ? `${configString}:` : "";
  const names = path.split("/");
  // An archive with a "/" after it: thus not the last name.
  for (let index = 0; index < names.length - 1; index++) {
    const open = names[index] && formatOf(names[index]);
    if (open) {
      return {
        location: head + encodePath(names.slice(0, index + 1).join("/")),
        inner: names.slice(index + 1).join("/"),
        open,
      };
    }
  }
  return { location: head + encodePath(path), inner: null };
}

/**
 * The path of rclone in the path of a request with no option `remote`. As
 * rclone, the path is the remote and its path, for example
 * `/s3:bucket/files.zip/` for `:archive:s3:bucket/files.zip/`. A path with
 * no remote is a local path, from the root.
 * @param {string} path
 */
function pathOf(path) {
  const text = path.slice(1);
  try {
    if (text && parse(text).name) return text;
  } catch {
    // Not a remote: a local path.
  }
  return path;
}

/**
 * The list of a folder of the remote, as rclone: a folder for each archive,
 * with the time of the archive, and the times to the second, the precision
 * of the archive remote.
 * @param {import("@rfetch/lib/listing").Entry[]} entries
 */
function archivesAsFolders(entries) {
  return entries.map((entry) => {
    const ModTime = entry.ModTime.replace(/\.\d+(?=Z|[+-]\d\d:\d\d$)/i, "");
    return !entry.IsDir && formatOf(entry.Name)
      ? { ...entry, IsDir: true, Size: -1, MimeType: "", ModTime }
      : { ...entry, ModTime };
  });
}

/**
 * The entries of a folder of an archive, or null when the folder is not in
 * the archive. The folders that are not in the index have the time of now,
 * as rclone.
 * @param {import("./entry.js").Entry[]} entries
 * @param {string} folder The path of the folder, "" for the root.
 * @returns {import("@rfetch/lib/listing").Entry[] | null}
 */
function listOf(entries, folder) {
  const now = new Date().toISOString();
  const prefix = folder ? `${folder}/` : "";
  /** @type {Map<string, import("@rfetch/lib/listing").Entry>} */
  const folders = new Map();
  /** @type {import("@rfetch/lib/listing").Entry[]} */
  const files = [];
  let found = folder === "";
  for (const entry of entries) {
    if (entry.path === folder && entry.isDir) found = true;
    if (!entry.path.startsWith(prefix)) continue;
    found = true;
    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash !== -1) {
      // A file or a folder in a folder of this folder.
      const name = rest.slice(0, slash);
      if (!folders.has(name)) {
        folders.set(name, {
          Name: name,
          IsDir: true,
          Size: -1,
          MimeType: "",
          ModTime: now,
        });
      }
    } else if (entry.isDir) {
      // The time of the folder, from the index.
      folders.set(rest, {
        Name: rest,
        IsDir: true,
        Size: -1,
        MimeType: "",
        ModTime: entry.modTime || now,
      });
    } else {
      files.push({
        Name: rest,
        IsDir: false,
        Size: entry.size,
        MimeType: mimeType(rest),
        ModTime: entry.modTime,
      });
    }
  }
  return found ? [...folders.values(), ...files] : null;
}

/**
 * Sends the requests of an archive remote to its remote with the global
 * `fetch`.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_ARCHIVE_*` or `RCLONE_ARCHIVE_*`.
 * @returns {Promise<Response>}
 */
async function archive(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);
  const remote = optionsOf(request, "archive", env).get("remote")
    ?.replace(/\/$/, "");
  const path = decodePath(pathname);
  if (path === null) {
    await request.body?.cancel();
    return new Response(null, { status: 400 });
  }

  /** @type {ReturnType<typeof locate>} */
  let target;
  try {
    target = locate(remote ? `${remote}${path}` : pathOf(path));
  } catch (error) {
    await request.body?.cancel();
    return new Response(error.message, { status: 400 });
  }
  const headers = remoteHeaders(
    request.headers,
    "archive",
    target.location,
  );

  if (target.inner === null) {
    // A path out of the archives: the request goes to the remote.
    /** @type {RequestInit} */
    const init = { method, headers };
    if (request.body) {
      init.body = request.body;
      init.duplex = "half";
    }
    const response = await fetch(target.location, init);
    if (!response.ok) return response;
    if (path.endsWith("/") && (method === "GET" || method === "HEAD")) {
      const answer = new Headers(response.headers);
      answer.delete("Content-Length");
      answer.set("Content-Type", "text/html;charset=utf-8");
      if (method === "HEAD") {
        await response.body?.cancel();
        return new Response(null, { status: response.status, headers: answer });
      }
      const entries = await readListing(
        response,
        new URL("http://remote/folder/"),
      );
      return new Response(
        renderListing(archivesAsFolders(entries), { query: `${searchParams}` }),
        { status: response.status, headers: answer },
      );
    }
    if (method === "PUT") {
      const answer = new Headers(response.headers);
      answer.set("Content-Location", pathname);
      return new Response(response.body, {
        status: response.status,
        headers: answer,
      });
    }
    return response;
  }

  // A path in an archive.
  if (method !== "GET" && method !== "HEAD") {
    await request.body?.cancel();
    return new Response("read only file system", { status: 403 });
  }
  // The headers of a request for a part of the archive.
  const plain = new Headers(headers);
  for (const name of ["Range", "If-Range", "Content-Length", "Content-Type"]) {
    plain.delete(name);
  }
  const file = new RangedFile((extra) => {
    const init = new Headers(plain);
    for (const [name, value] of extra) init.set(name, value);
    return fetch(target.location, { headers: init });
  });

  try {
    const entries = await target.open(file);
    const { inner } = target;
    if (inner === "" || inner.endsWith("/")) {
      const list = listOf(entries, inner.replace(/\/$/, ""));
      if (list === null) {
        return new Response("directory not found", { status: 404 });
      }
      const body = method === "HEAD"
        ? null
        : renderListing(list, { query: `${searchParams}` });
      return new Response(body, {
        headers: { "Content-Type": "text/html;charset=utf-8" },
      });
    }

    const entry = entries.find((item) => item.path === inner && !item.isDir);
    if (!entry) return new Response("object not found", { status: 404 });
    const answer = new Headers({
      "Content-Type": mimeType(inner),
      "Accept-Ranges": "bytes",
    });
    const time = Date.parse(entry.modTime);
    if (!isNaN(time)) answer.set("Last-Modified", new Date(time).toUTCString());

    let range = null;
    if (method === "GET") {
      try {
        range = parseRange(request.headers.get("Range"), entry.size);
      } catch {
        return notSatisfiable(entry.size);
      }
    }
    if (range) {
      for (
        const [name, value] of Object.entries(partialHeaders(range, entry.size))
      ) {
        answer.set(name, value);
      }
    } else {
      answer.set("Content-Length", `${entry.size}`);
    }
    if (method === "HEAD") return new Response(null, { headers: answer });

    const length = range ? range.end - range.start + 1 : entry.size;
    const stream = await entry.open(range);
    return new Response(sized(stream, length), {
      status: range ? 206 : 200,
      headers: answer,
    });
  } catch (error) {
    if (error instanceof RemoteError) return error.response;
    if (error instanceof ArchiveError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
}

export default {
  fetch: archive,
};
