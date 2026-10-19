/**
 * Tiles remote
 *
 * The `tiles` remote reads the map tiles in the files of tiles of another
 * remote, with no download of all the file. rclone has no such backend.
 * Each file of tiles is a folder:
 *
 * - `metadata.json`: the metadata of the file, in JSON.
 * - `Z/X/Y.EXT`: the tile Y of the column X at the zoom level Z, for
 *   example `14/8185/5449.mvt`. The extension comes from the type of the
 *   tiles: `.mvt`, `.png`, `.jpg`, `.webp`, `.avif` or `.mlt`, and none
 *   for a type that is not known.
 *
 * The formats are known by their names:
 *
 * - PMTiles, version 3: `.pmtiles`. See `pmtiles.js`.
 *
 * As the archive remote, a named remote tells the remote of the files with
 * the option `remote`, for example `remote = r2:maps`. Then
 * `maps:city.pmtiles/14/8185/5449.mvt` is a tile of `r2:maps/city.pmtiles`.
 * The remote can also be in the path, as `:archive:` of rclone:
 * `:tiles:r2:maps/city.pmtiles/14/8185/5449.mvt`. The tiles are read only.
 * The other files of the remote are read and written as normal.
 *
 * A tile in gzip, brotli or zstd follows the header `Accept-Encoding` of the
 * request. When the request accepts the encoding, for example from a
 * browser, the answer has the stored bytes with `Content-Encoding`: no CPU
 * time, also for brotli in a Worker. Else the tile is decompressed, for
 * example for `rfetch cat` or a copy, and the file is the tile. In a Worker
 * of Cloudflare, the request has the `Accept-Encoding` of Cloudflare, not
 * of the client: Cloudflare decodes the answer for a client that does not
 * accept the encoding. The size of
 * a decompressed tile is not known before the decompression: thus its size
 * in a list is -1, and a compressed tile has no ranges. A tile with no
 * compression, for example most PNG and JPEG tiles, has its size and
 * ranges.
 *
 * Costs: a tile needs one request for the start of the file, one for each
 * leaf directory on its path, and one for its data. A list of a zoom level
 * or of a column reads all the directories of that zoom level: a list of
 * more than 100000 tiles, or one that needs more than 32 leaf directories,
 * gives 501. rfetch keeps no data between requests.
 */
import { renderListing } from "@rfetch/lib/listing";
import { optionsOf, remoteHeaders } from "@rfetch/lib/options";
import { locate, partHeaders, passThrough, pathOf } from "@rfetch/lib/overlay";
import { decodePath } from "@rfetch/lib/path";
import { notSatisfiable, parseRange, partialHeaders } from "@rfetch/lib/range";
import { RangedFile, RemoteError } from "@rfetch/lib/ranged";
import { sized } from "@rfetch/lib/sized";

import { PMTiles } from "./pmtiles.js";
import { accepts, decoder, TilesError, typeOf } from "./tileset.js";

/**
 * The options of the backend, with their types, for example for the flag
 * `--tiles-remote` of the command line.
 */
export const options = {
  string: ["remote"],
};

/**
 * The readers of the files of tiles, by the extension of their names.
 * @type {Map<string, (file: RangedFile) =>
 *   Promise<import("./tileset.js").TileSet>>}
 */
const FORMATS = new Map([
  [".pmtiles", (file) => PMTiles.open(file)],
]);

/**
 * The reader of a file of tiles from its name, or undefined for a name of
 * another file.
 * @param {string} name
 */
export function formatOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? undefined : FORMATS.get(name.slice(dot));
}

/** The most tiles in a list. */
const LIST_LIMIT = 100_000;

/** The highest zoom level of a path. */
const MAX_ZOOM = 30;

/** The content codings that a client can decode. */
const CODINGS = new Set(["gzip", "br", "zstd"]);

/** The name of the metadata in the folder of a file of tiles. */
const METADATA = "metadata.json";

/**
 * The list of a folder of the remote: a folder for each file of tiles.
 * @param {import("@rfetch/lib/listing").Entry[]} entries
 */
function filesAsFolders(entries) {
  return entries.map((entry) =>
    !entry.IsDir && formatOf(entry.Name)
      ? { ...entry, IsDir: true, Size: -1, MimeType: "" }
      : entry
  );
}

/**
 * Reads a number of a path: digits with no 0 before them, as the names of
 * the folders and of the tiles. Thus each tile has one name.
 * @param {string} text
 * @returns {number | null}
 */
function numberOf(text) {
  return /^(?:0|[1-9]\d{0,9})$/.test(text) ? Number(text) : null;
}

/**
 * A path in a file of tiles.
 * @typedef {{ kind: "root" } | { kind: "metadata" } |
 *   { kind: "zoom", z: number } | { kind: "column", z: number, x: number } |
 *   { kind: "tile", z: number, x: number, y: number }} Place
 */

/**
 * Reads a path in a file of tiles, or gives null for a path that the file
 * cannot have.
 * @param {string} inner The path in the file, "" for its root.
 * @param {string} extension The extension of the tiles, with its dot.
 * @returns {Place | null}
 */
function placeOf(inner, extension) {
  if (inner === "") return { kind: "root" };
  if (inner === METADATA) return { kind: "metadata" };
  const folder = inner.endsWith("/");
  const names = (folder ? inner.slice(0, -1) : inner).split("/");
  if (names.length > 3 || (folder ? names.length > 2 : names.length < 3)) {
    return null;
  }
  if (names.length === 3) {
    if (!names[2].endsWith(extension)) return null;
    names[2] = names[2].slice(0, names[2].length - extension.length);
  }
  const numbers = names.map(numberOf);
  if (numbers.some((number) => number === null)) return null;
  const [z, x, y] = /** @type {number[]} */ (numbers);
  if (z > MAX_ZOOM) return null;
  const size = 2 ** z;
  if (x >= size || y >= size) return null;
  if (names.length === 1) return { kind: "zoom", z };
  if (names.length === 2) return { kind: "column", z, x };
  return { kind: "tile", z, x, y };
}

/** @param {string} message */
const notFound = (message) => new Response(message, { status: 404 });

/**
 * Answers a request for a path in a file of tiles.
 * @param {Request} request
 * @param {RangedFile} file
 * @param {import("./tileset.js").TileSet} tiles
 * @param {string} inner
 * @returns {Promise<Response>}
 */
async function answer(request, file, tiles, inner) {
  const { method } = request;
  const { searchParams } = new URL(request.url);
  const { extension, mime } = typeOf(tiles.type);
  const place = placeOf(inner, extension);
  const folder = inner === "" || inner.endsWith("/");
  if (place === null) {
    return notFound(folder ? "directory not found" : "object not found");
  }
  const lastModified = file.lastModified && Date.parse(file.lastModified);
  const time = lastModified
    ? new Date(lastModified).toISOString()
    : new Date().toISOString();
  const inZooms = (/** @type {number} */ z) =>
    z >= tiles.minZoom && z <= tiles.maxZoom;

  /** @param {import("@rfetch/lib/listing").Entry[]} entries */
  const list = (entries) =>
    new Response(
      method === "HEAD"
        ? null
        : renderListing(entries, { query: `${searchParams}` }),
      { headers: { "Content-Type": "text/html;charset=utf-8" } },
    );
  /** @param {string} Name */
  const folderOf = (Name) => ({
    Name,
    IsDir: true,
    Size: -1,
    MimeType: "",
    ModTime: time,
  });

  /**
   * The headers of a file, with its size when it is known, and its range.
   * @param {string} type
   * @param {number | null} size
   * @returns {{ headers: Headers, range: { start: number, end: number } | null } | Response}
   */
  const fileHeaders = (type, size) => {
    const headers = new Headers({ "Content-Type": type });
    if (lastModified) {
      headers.set("Last-Modified", new Date(lastModified).toUTCString());
    }
    if (size === null) {
      // A decompressed tile: no size before the decompression.
      headers.set("Accept-Ranges", "none");
      return { headers, range: null };
    }
    headers.set("Accept-Ranges", "bytes");
    let range = null;
    if (method === "GET") {
      try {
        range = parseRange(request.headers.get("Range"), size);
      } catch {
        return notSatisfiable(size);
      }
    }
    if (range) {
      for (const [name, value] of Object.entries(partialHeaders(range, size))) {
        headers.set(name, value);
      }
    } else {
      headers.set("Content-Length", `${size}`);
    }
    return { headers, range };
  };

  switch (place.kind) {
    case "root": {
      const metadata = await tiles.metadata();
      const zooms = [];
      for (let z = tiles.minZoom; z <= tiles.maxZoom; z++) {
        zooms.push(folderOf(`${z}`));
      }
      return list([...zooms, {
        Name: METADATA,
        IsDir: false,
        Size: metadata.length,
        MimeType: "application/json",
        ModTime: time,
      }]);
    }

    case "metadata": {
      const metadata = await tiles.metadata();
      const result = fileHeaders("application/json", metadata.length);
      if (result instanceof Response) return result;
      const { headers, range } = result;
      if (method === "HEAD") return new Response(null, { headers });
      return new Response(
        range ? metadata.slice(range.start, range.end + 1) : metadata,
        { status: range ? 206 : 200, headers },
      );
    }

    case "zoom":
    case "column": {
      const { z } = place;
      if (!inZooms(z)) return notFound("directory not found");
      const found = await tiles.zoom(z, LIST_LIMIT);
      if (place.kind === "zoom") {
        const columns = new Set(found.map(({ x }) => x));
        return list(
          [...columns].sort((a, b) => a - b).map((x) => folderOf(`${x}`)),
        );
      }
      const stored = tiles.encoding === "identity";
      const files = found.filter(({ x }) => x === place.x)
        .sort((a, b) => a.y - b.y)
        .map(({ y, length }) => ({
          Name: `${y}${extension}`,
          IsDir: false,
          Size: stored ? length : -1,
          MimeType: mime,
          ModTime: time,
        }));
      if (files.length === 0) return notFound("directory not found");
      return list(files);
    }

    case "tile": {
      const { z, x, y } = place;
      if (!inZooms(z)) return notFound("object not found");
      const tile = await tiles.tile(z, x, y);
      if (!tile) return notFound("object not found");
      const { encoding } = tiles;
      if (encoding !== "identity") {
        if (
          CODINGS.has(encoding) &&
          accepts(request.headers.get("Accept-Encoding"), encoding)
        ) {
          // The stored bytes, for a client that decodes them.
          const headers = new Headers({
            "Content-Type": mime,
            "Content-Encoding": encoding,
            "Content-Length": `${tile.length}`,
            "Accept-Ranges": "none",
            "Vary": "Accept-Encoding",
          });
          if (lastModified) {
            headers.set("Last-Modified", new Date(lastModified).toUTCString());
          }
          if (method === "HEAD") return new Response(null, { headers });
          const data = await file.stream(tile.offset, tile.length);
          // A Worker sends the bytes as they are, with no second encoding.
          return new Response(sized(data, tile.length), {
            headers,
            encodeBody: "manual",
          });
        }
        const stream = decoder(encoding, tiles.format, "the tiles");
        const result = fileHeaders(mime, null);
        if (result instanceof Response) return result;
        const { headers } = result;
        headers.set("Vary", "Accept-Encoding");
        if (method === "HEAD") return new Response(null, { headers });
        const data = await file.stream(tile.offset, tile.length);
        return new Response(
          data.pipeThrough(/** @type {DecompressionStream} */ (stream)),
          { headers },
        );
      }
      const result = fileHeaders(mime, tile.length);
      if (result instanceof Response) return result;
      const { headers, range } = result;
      if (method === "HEAD") return new Response(null, { headers });
      const start = tile.offset + (range?.start ?? 0);
      const length = range ? range.end - range.start + 1 : tile.length;
      const data = await file.stream(start, length);
      return new Response(sized(data, length), {
        status: range ? 206 : 200,
        headers,
      });
    }
  }
}

/**
 * Sends the requests of a tiles remote to its remote with the global
 * `fetch`.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_TILES_*` or `RCLONE_TILES_*`.
 * @returns {Promise<Response>}
 */
async function tiles(request, env = {}) {
  const { method } = request;
  const { pathname } = new URL(request.url);
  const remote = optionsOf(request, "tiles", env).get("remote")
    ?.replace(/\/$/, "");
  const path = decodePath(pathname);
  if (path === null) {
    await request.body?.cancel();
    return new Response(null, { status: 400 });
  }

  /** @type {{ location: string, inner: string | null, format?: NonNullable<ReturnType<typeof formatOf>> }} */
  let target;
  try {
    target = locate(remote ? `${remote}${path}` : pathOf(path), formatOf);
  } catch (error) {
    await request.body?.cancel();
    return new Response(error.message, { status: 400 });
  }
  const headers = remoteHeaders(request.headers, "tiles", target.location);

  if (target.inner === null || !target.format) {
    // A path out of the files of tiles: the request goes to the remote.
    return await passThrough(request, target.location, headers, filesAsFolders);
  }

  // A path in a file of tiles.
  if (method !== "GET" && method !== "HEAD") {
    await request.body?.cancel();
    return new Response("read only file system", { status: 403 });
  }
  const plain = partHeaders(headers);
  // The remote sends the stored bytes of the file.
  plain.delete("Accept-Encoding");
  const file = new RangedFile((extra) => {
    const init = new Headers(plain);
    for (const [name, value] of extra) init.set(name, value);
    return fetch(target.location, { headers: init });
  });

  try {
    const set = await target.format(file);
    return await answer(request, file, set, target.inner);
  } catch (error) {
    if (error instanceof RemoteError) return error.response;
    if (error instanceof TilesError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
}

export default {
  fetch: tiles,
};
