/**
 * Compress remote
 *
 * The `compress` remote compresses the files of another remote, as the
 * compress backend of rclone, and reads the files that rclone compresses.
 *
 * Each file is two files in the remote:
 *
 * - The data: `NAME.SIZE.gz`, with the size of the file in 11 characters
 *   of base64, or `NAME.bin` for a file that is not compressed.
 * - The metadata: `NAME.json`, with the mode, the size, the MD5 hash, the
 *   type and the blocks of the gzip data.
 *
 * Options:
 *
 * - `remote`: the remote to compress.
 * - `mode`: `gzip` by default. rfetch does not write or read `zstd` yet.
 *   With another mode, the files are not compressed, as rclone.
 * - `level`: the level of gzip, from -2 to 9. As rclone, it is 0 when the
 *   option is not set: then the data are in gzip, but not compressed.
 *
 * A file goes in gzip only when its first MiB compresses 1.1 times or more,
 * as rclone. For a file of 128 bytes or more with few repeats, rclone and
 * rfetch can decide differently: see `isCompressible`.
 *
 * As the other backends of rfetch, compress gives the type of a file from
 * its name. rclone gives the type in the metadata of the file: the type of
 * its first bytes. In the metadata, rfetch writes text or not from the
 * first bytes: rclone knows more types.
 *
 * rfetch must know the size of a file in gzip for its name. For a PUT with
 * no `Content-Length`, it keeps the file in memory.
 */

import { createHash } from "node:crypto";

import { readListing, renderListing } from "@rfetch/lib/listing";
import { mimeType } from "@rfetch/lib/mime";
import { optionsOf, remoteHeaders } from "@rfetch/lib/options";
import { decodePath, encodePath } from "@rfetch/lib/path";
import {
  notSatisfiable,
  parseRange,
  partialHeaders,
  sliceStream,
} from "@rfetch/lib/range";

import {
  blocksFor,
  checkLevel,
  GzipStream,
  isCompressible,
  SAMPLE_SIZE,
} from "./gzip.js";

/**
 * The options of the backend, with their types, for example for the flag
 * `--compress-mode` of the command line.
 */
export const options = {
  string: ["remote", "mode", "level", "ram_cache_limit"],
};

/** The modes of compression of rclone, in the metadata. */
const UNCOMPRESSED = 0;
const GZIP = 2;
const ZSTD = 4;

/** The metadata of a file: `ObjectMetadata` of rclone, in JSON. */
/**
 * @typedef {Object} Metadata
 * @property {number} Mode
 * @property {number} Size
 * @property {string} MD5
 * @property {string} MimeType
 * @property {import("./gzip.js").GzipMetadata | null} CompressionMetadataGzip
 * @property {unknown} CompressionMetadataZstd
 */

/**
 * The mode of compression of a name, as `compressionModeFromName` of rclone:
 * a name that is not `gzip` or `zstd` is no compression.
 * @param {string} name
 */
function modeOf(name) {
  if (name === "gzip") return GZIP;
  if (name === "zstd") return ZSTD;
  return UNCOMPRESSED;
}

/** The data names of rclone: the name, then the size in base64. */
const DATA_NAME = /^(.+?)\.([A-Za-z0-9-_]{11})$/;

/**
 * The size of a file in its data name: 8 bytes in little endian, in base64
 * for URLs with no padding.
 * @param {number} size
 */
export function sizeName(size) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, BigInt(size), true);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * The size of a file from its data name.
 * @param {string} text 11 characters of base64 for URLs.
 * @returns {number | null}
 */
function sizeOf(text) {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    if (binary.length !== 8) return null;
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    return Number(new DataView(bytes.buffer).getBigInt64(0, true));
  } catch {
    return null;
  }
}

/**
 * The name of the data of a file, as `makeDataName` of rclone.
 * @param {string} path
 * @param {number} size
 * @param {number} mode
 */
export function dataName(path, size, mode) {
  if (mode === GZIP) return `${path}.${sizeName(size)}.gz`;
  if (mode === ZSTD) return `${path}.${sizeName(size)}.zst`;
  return `${path}.bin`;
}

/**
 * The name and the size of a file from the name of its data, as
 * `processFileName` of rclone.
 * @param {string} name For example `a.txt.uhQsAAAAAAA.gz` or `a.txt.bin`.
 * @returns {{ name: string, size: number | null } | null} The size is null
 *   for a file that is not compressed: it is the size of the data. Null for
 *   a name that is not the name of data.
 */
export function fileOf(name) {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  const extension = name.slice(dot);
  const rest = name.slice(0, dot);
  if (extension === ".bin") return { name: rest, size: null };
  const match = rest.match(DATA_NAME);
  if (!match) return null;
  const size = sizeOf(match[2]);
  return size === null ? null : { name: match[1], size };
}

/**
 * The type of a file from its first bytes: text or not. rclone knows more
 * types.
 * @param {Uint8Array} sample
 */
function typeOf(sample) {
  if (sample.length === 0) return "text/plain";
  // The binary bytes of the sniffing of WHATWG.
  for (const byte of sample) {
    if (
      byte <= 0x08 || byte === 0x0b || (byte >= 0x0e && byte <= 0x1a) ||
      (byte >= 0x1c && byte <= 0x1f)
    ) {
      return "application/octet-stream";
    }
  }
  try {
    // A character at the end of the sample can be in two parts.
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return "text/plain; charset=utf-8";
  } catch {
    return "text/plain";
  }
}

/**
 * Reads the first bytes of a stream, and gives a stream of all its bytes.
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {number} limit
 * @returns {Promise<{ sample: Uint8Array, stream: ReadableStream<Uint8Array> }>}
 */
async function sampleOf(body, limit) {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let length = 0;
  const reader = body?.getReader();
  let done = !reader;
  while (!done && length < limit) {
    const result = await reader.read();
    if (result.done) {
      done = true;
    } else {
      chunks.push(result.value);
      length += result.value.length;
    }
  }
  const head = concat(chunks);
  const stream = new ReadableStream({
    start(controller) {
      if (head.length > 0) controller.enqueue(head);
      if (done) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader?.cancel(reason),
  });
  return { sample: head.subarray(0, limit), stream };
}

/** @param {Uint8Array[]} chunks */
function concat(chunks) {
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(
    chunks.reduce((sum, { length }) => sum + length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * A stream that counts the bytes and makes their MD5 hash.
 * @extends {TransformStream<Uint8Array, Uint8Array>}
 */
class HashStream extends TransformStream {
  size = 0;
  md5 = "";

  constructor() {
    const hash = createHash("md5");
    super({
      transform: (chunk, controller) => {
        hash.update(chunk);
        this.size += chunk.length;
        controller.enqueue(chunk);
      },
      flush: () => {
        this.md5 = hash.digest("hex");
      },
    });
  }
}

/**
 * Sends the requests of a compress remote to its remote with the global
 * `fetch`.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_COMPRESS_*` or `RCLONE_COMPRESS_*`.
 * @returns {Promise<Response>}
 */
async function compress(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);
  const options = optionsOf(request, "compress", env);

  const remote = options.get("remote")?.replace(/\/$/, "");
  if (!remote) {
    await request.body?.cancel();
    return new Response("Missing remote", { status: 400 });
  }
  const mode = modeOf(options.get("mode") || "gzip");
  const level = Number(options.get("level") || "0");
  const path = decodePath(pathname);
  if (path === null) {
    await request.body?.cancel();
    return new Response(null, { status: 400 });
  }

  /**
   * Sends a request to a path in the remote, with the headers of the request
   * by default.
   * @param {string} path
   * @param {RequestInit} [init]
   */
  const send = (path, init = {}) =>
    fetch(remote + encodePath(path), {
      ...init,
      headers: remoteHeaders(init.headers ?? plain, "compress", remote),
    });
  // The headers for a request with no body and no range.
  const plain = new Headers(request.headers);
  for (const name of ["Content-Length", "Content-Type", "Range"]) {
    plain.delete(name);
  }

  // A folder is the folder of the remote.
  if (path.endsWith("/")) {
    if (method !== "GET") {
      /** @type {RequestInit} */
      const init = { method, headers: request.headers };
      if (request.body) {
        init.body = request.body;
        init.duplex = "half";
      }
      const response = await send(path, init);
      if (method !== "PUT" || !response.ok) return response;
      // The location of a new folder is in this remote.
      const headers = new Headers(response.headers);
      headers.set("Content-Location", pathname);
      return new Response(response.body, { status: response.status, headers });
    }
    const response = await send(path);
    if (!response.ok) return response;
    const entries = [];
    for (
      const entry of await readListing(
        response,
        new URL("http://remote/folder/"),
      )
    ) {
      if (entry.IsDir) {
        entries.push(entry);
        continue;
      }
      // The metadata are not files of the list.
      if (entry.Name.endsWith(".json")) continue;
      const file = fileOf(entry.Name);
      if (!file) continue;
      entries.push({
        ...entry,
        Name: file.name,
        Size: file.size ?? entry.Size,
        MimeType: mimeType(file.name),
      });
    }
    return new Response(renderListing(entries, { query: `${searchParams}` }), {
      headers: { "Content-Type": "text/html;charset=utf-8" },
    });
  }

  /**
   * The metadata of the file, or an answer for an error.
   * @returns {Promise<Metadata | null | Response>} Null for a file that does
   *   not exist.
   */
  const metadataOf = async () => {
    const response = await send(`${path}.json`);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) return response;
    try {
      return await response.json();
    } catch (error) {
      return new Response(`error decoding metadata: ${error.message}`, {
        status: 500,
      });
    }
  };

  if (method === "GET" || method === "HEAD") {
    const metadata = await metadataOf();
    if (metadata instanceof Response) return metadata;
    if (metadata === null) {
      return new Response("object not found", { status: 404 });
    }
    return await read(request, metadata, path, send, plain);
  }

  if (method === "DELETE") {
    const metadata = await metadataOf();
    if (metadata instanceof Response) return metadata;
    if (metadata === null) {
      return new Response("object not found", { status: 404 });
    }
    // As rclone, the metadata go first, then the data.
    const removed = await send(`${path}.json`, { method: "DELETE" });
    await removed.body?.cancel();
    const data = await send(dataName(path, metadata.Size, metadata.Mode), {
      method: "DELETE",
    });
    if (!removed.ok) return removed;
    return data;
  }

  if (method === "PUT") {
    try {
      if (mode === GZIP) checkLevel(level);
    } catch (error) {
      await request.body?.cancel();
      return new Response(error.message, { status: 400 });
    }
    if (mode === ZSTD) {
      await request.body?.cancel();
      return new Response("rfetch does not write zstd yet", { status: 501 });
    }
    const old = await metadataOf();
    if (old instanceof Response) {
      await request.body?.cancel();
      return old;
    }
    return await write(request, {
      path,
      mode,
      level,
      old,
      send,
      plain,
      pathname,
    });
  }

  await request.body?.cancel();
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET, HEAD, PUT, DELETE" },
  });
}

/**
 * Reads a file: all of it, or a range.
 * @param {Request} request
 * @param {Metadata} metadata
 * @param {string} path
 * @param {(path: string, init?: RequestInit) => Promise<Response>} send
 * @param {Headers} plain
 * @returns {Promise<Response>}
 */
async function read(request, metadata, path, send, plain) {
  const { method } = request;
  const name = dataName(path, metadata.Size, metadata.Mode);
  const headers = new Headers({
    "Content-Type": mimeType(path),
    "Accept-Ranges": "bytes",
  });

  if (metadata.Mode === UNCOMPRESSED) {
    // The data are the file: the remote reads the range.
    const response = await send(name, {
      method,
      headers: request.headers,
    });
    if (!response.ok && response.status !== 416) return response;
    const answer = new Headers(response.headers);
    answer.set("Content-Type", headers.get("Content-Type"));
    return new Response(response.body, {
      status: response.status,
      headers: answer,
    });
  }
  if (metadata.Mode !== GZIP) {
    return new Response("rfetch does not read zstd yet", { status: 501 });
  }

  const size = metadata.Size;
  /** @type {{ start: number, end: number } | null} */
  let range = null;
  if (method === "GET") {
    try {
      range = parseRange(request.headers.get("Range"), size);
    } catch {
      return notSatisfiable(size);
    }
  }

  if (method === "HEAD") {
    const response = await send(name, { method: "HEAD" });
    await response.body?.cancel();
    if (!response.ok) return response;
    headers.set("Content-Length", `${size}`);
    const time = response.headers.get("Last-Modified");
    if (time) headers.set("Last-Modified", time);
    return new Response(null, { headers });
  }

  const blocks = range &&
    blocksFor(metadata.CompressionMetadataGzip ?? {}, range.start);
  if (range && blocks) {
    // The data from the block of the first byte: each block starts a new
    // deflate stream with no dictionary.
    const rangeHeaders = new Headers(plain);
    rangeHeaders.set("Range", `bytes=${blocks.from}-${blocks.to}`);
    const response = await send(name, { headers: rangeHeaders });
    if (!response.ok) return response;
    const time = response.headers.get("Last-Modified");
    if (time) headers.set("Last-Modified", time);
    for (const [key, value] of Object.entries(partialHeaders(range, size))) {
      headers.set(key, value);
    }
    const body = sliceStream(
      response.body.pipeThrough(new DecompressionStream("deflate-raw")),
      blocks.skip,
      range.end - range.start + 1,
    );
    return new Response(body, { status: 206, headers });
  }

  const response = await send(name);
  if (!response.ok) return response;
  const time = response.headers.get("Last-Modified");
  if (time) headers.set("Last-Modified", time);
  let body = response.body.pipeThrough(new DecompressionStream("gzip"));
  if (range) {
    for (const [key, value] of Object.entries(partialHeaders(range, size))) {
      headers.set(key, value);
    }
    body = sliceStream(body, range.start, range.end - range.start + 1);
    return new Response(body, { status: 206, headers });
  }
  headers.set("Content-Length", `${size}`);
  return new Response(body, { headers });
}

/**
 * Writes a file: its data, then its metadata, then it deletes the data of
 * the file before when their name is not the same, as `Update` of rclone.
 * @param {Request} request
 * @param {{
 *   path: string,
 *   mode: number,
 *   level: number,
 *   old: Metadata | null,
 *   send: (path: string, init?: RequestInit) => Promise<Response>,
 *   plain: Headers,
 *   pathname: string,
 * }} options
 * @returns {Promise<Response>}
 */
async function write(
  request,
  { path, mode, level, old, send, plain, pathname },
) {
  const header = request.headers.get("Content-Length");
  let size = header === null ? -1 : Number(header);
  let { sample, stream } = await sampleOf(request.body, SAMPLE_SIZE);
  const compressible = mode === GZIP && isCompressible(sample);
  const type = typeOf(sample);

  // The name of the data has the size of the file.
  if (compressible && size < 0) {
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    size = bytes.length;
    stream = new Blob([bytes]).stream();
  }

  const hash = new HashStream();
  const hashed = stream.pipeThrough(hash);
  /** @type {Metadata} */
  let metadata;
  let name;
  const headers = new Headers(plain);
  if (compressible) {
    const gzip = new GzipStream(level);
    name = dataName(path, size, GZIP);
    const response = await send(name, {
      method: "PUT",
      body: hashed.pipeThrough(gzip),
      duplex: "half",
      headers,
    });
    await response.body?.cancel();
    if (!response.ok) return response;
    metadata = {
      Mode: GZIP,
      Size: hash.size,
      MD5: hash.md5,
      MimeType: type,
      CompressionMetadataGzip: gzip.metadata,
      CompressionMetadataZstd: null,
    };
  } else {
    name = dataName(path, size, UNCOMPRESSED);
    if (size >= 0) headers.set("Content-Length", `${size}`);
    const response = await send(name, {
      method: "PUT",
      body: hashed,
      duplex: "half",
      headers,
    });
    await response.body?.cancel();
    if (!response.ok) return response;
    metadata = {
      Mode: UNCOMPRESSED,
      Size: hash.size,
      MD5: hash.md5,
      MimeType: type,
      CompressionMetadataGzip: { BlockSize: 0, Size: 0, BlockData: null },
      CompressionMetadataZstd: null,
    };
  }

  // As rclone, a file must have the size of its Content-Length.
  if (size >= 0 && hash.size !== size) {
    await send(name, { method: "DELETE" }).then((r) => r.body?.cancel());
    return new Response(
      `expected ${size} bytes in input, but got ${hash.size}: unexpected EOF`,
      { status: 400 },
    );
  }

  const json = new Headers(plain);
  json.set("Content-Type", "application/json");
  const saved = await send(`${path}.json`, {
    method: "PUT",
    body: JSON.stringify(metadata),
    headers: json,
  });
  await saved.body?.cancel();
  if (!saved.ok) {
    await send(name, { method: "DELETE" }).then((r) => r.body?.cancel());
    return saved;
  }
  if (old && dataName(path, old.Size, old.Mode) !== name) {
    const removed = await send(dataName(path, old.Size, old.Mode), {
      method: "DELETE",
    });
    await removed.body?.cancel();
  }
  return new Response(null, {
    status: 201,
    headers: { "Content-Location": pathname },
  });
}

export default {
  fetch: compress,
};
