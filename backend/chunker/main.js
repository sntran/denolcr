/**
 * Chunker
 *
 * The chunker overlay transparently splits large files into smaller chunks
 * during upload to wrapped remote and transparently assembles them back when
 * the file is downloaded. This allows to effectively overcome size limits
 * imposed by storage providers.
 *
 * ## Chunking
 *
 * When rfetch starts a file upload, chunker checks the file size. If it
 * doesn't exceed the configured chunk size, chunker will just pass the file to
 * the wrapped remote. If a file is large, chunker will transparently cut data
 * in pieces with temporary names and stream them one by one, on the fly. Each
 * data chunk will contain the specified number of bytes, except for the last
 * one which may have less data. If file size is unknown in advance (this is
 * called a streaming upload), chunker will internally create a temporary copy,
 * record its size and repeat the above process.
 *
 * rclone puts the chunks with temporary names, and renames them when the
 * upload is complete. The backends of rfetch cannot rename. Thus with the
 * transactions `rename`, the chunks get their last names at once, and a
 * reader can see a file that is not complete. With the transactions
 * `norename`, the chunks have the suffix of the transaction, and the file
 * changes only when its metadata changes. See `putFile`.
 *
 * When a composite file download is requested, chunker transparently assembles
 * it by concatenating data chunks in order. As the split is trivial one could
 * even manually concatenate data chunks together to obtain the original
 * content.
 *
 * When the `list` rfetch command scans a directory on wrapped remote, the
 * potential chunk files are accounted for, grouped and assembled into
 * composite directory entries. Any temporary chunks are hidden.
 *
 * List and other commands can sometimes come across composite files with
 * missing or invalid chunks, e.g. shadowed by like-named directory or another
 * file. This usually means that wrapped file system has been directly tampered
 * with or damaged. If chunker detects a missing chunk it will by default print
 * warning, skip the whole incomplete group of chunks but proceed with current
 * command. You can set the `--chunker-fail-hard` flag to have commands abort
 * with error message in such cases.
 *
 * ### Chunk names
 *
 * The default chunk name format is `*.rclone_chunk.###`, hence by default
 * chunk names are `BIG_FILE_NAME.rclone_chunk.001`, etc. You can configure
 * another name format using the `name_format` configuration file option. The
 * format uses asterisk `*` as a placeholder for the base file name and one or
 * more consecutive hash characters `#` as a placeholder for sequential chunk
 * number. There must be one and only one asterisk. The number of consecutive
 * hash characters defines the minimum length of a string representing a chunk
 * number. If decimal chunk number has less digits than the number of hashes,
 * it is left-padded by zeros. If the decimal string is longer, it is left
 * intact. By default numbering starts from 1 but there is another option that
 * allows user to start from 0, e.g. for compatibility with legacy software.
 *
 * For example, if name format is `big_*-##.part` and original file name is
 * `data.txt` and numbering starts from 0, then the first chunk will be named
 * `big_data.txt-00.part`, the 99th chunk will be `big_data.txt-98.part` and
 * the 302nd chunk will become `big_data.txt-301.part`.
 *
 * Note that `list` assembles composite directory entries only when chunk names
 * match the configured format and treats non-conforming file names as normal
 * non-chunked files.
 *
 * When using `norename` transactions, chunk names will additionally have a
 * unique file version suffix. For example, `BIG_FILE.rclone_chunk.001_bp562k`.
 *
 * ## Metadata
 *
 * Besides data chunks chunker will by default create metadata object for a
 * composite file. The object is named after the original file. Chunker allows
 * user to disable metadata completely (the `none` format). Note that metadata
 * is normally not created for files smaller than the configured chunk size.
 * This may change in future rfetch releases.
 *
 * ### Simple JSON metadata format
 *
 * This is the default format. It supports hash sums and chunk validation for
 * composite files. Meta objects carry the following fields:
 *
 * - `ver` - version of format, currently `1`
 * - `size` - total size of composite file
 * - `nchunks` - number of data chunks in file
 * - `md5` - MD5 hashsum of composite file (if present)
 * - `sha1` - SHA1 hashsum (if present)
 * - `txn` - identifies current version of the file
 *
 * There is no field for composite file name as it's simply equal to the name
 * of meta object on the wrapped remote. Please refer to respective sections
 * for details on hashsums and modified time handling.
 *
 * ### No metadata
 *
 * You can disable meta objects by setting the meta format option to `none`. In
 * this mode chunker will scan directory for all files that follow configured
 * chunk name format, group them by detecting chunks with the same base name
 * and show group names as virtual composite files. This method is more prone
 * to missing chunk errors (especially missing last chunk) than format with
 * metadata enabled.
 */
import { createHash } from "node:crypto";
import { readListing, renderListing } from "../../lib/listing.js";
import { mimeType } from "../../lib/mime.js";
import { decodePath, encodePath } from "../../lib/path.js";
import {
  notSatisfiable,
  parseRange,
  partialHeaders,
  sliceStream,
} from "../../lib/range.js";
import { parseSize } from "../../lib/size.js";
import { sized } from "../../lib/streams/sized.js";

/** The largest metadata that rclone reads, and that it writes, in bytes. */
const MAX_METADATA_SIZE = 1023;
const MAX_METADATA_SIZE_WRITTEN = 255;
/** The version of the metadata with a transaction, and with none. */
const METADATA_VERSION = 2;
/** A control chunk has this type after "_" in place of its number. */
const CTRL_TYPE = "[a-z][a-z0-9]{2,6}";
/** The largest number of chunks of rclone. */
const MAX_CHUNKS = 10_000_000;

/**
 * @typedef {Object} Metadata
 * @property {number} ver - version of format
 * @property {number} size - total size of composite file
 * @property {number} nchunks - number of data chunks in file
 * @property {string} [md5] - MD5 hashsum of composite file
 * @property {string} [sha1] - SHA1 hashsum
 * @property {string} [txn] - identifies current version of the file
 */

export const options = {
  string: [
    "hash_type",
    "name_format",
    "meta_format",
    /**
     * Remote to chunk/unchunk.
     * Normally should contain a ':' and a path, e.g."myremote:path/to/dir",
     * "myremote:bucket" or maybe "myremote:" (not recommended).
     */
    "remote",
    "transactions",
  ],
  boolean: ["fail_hard"],
  default: {
    chunk_size: "2Gi",
    hash_type: "md5", // | "sha1" | "md5all" | "sha1all" | "md5quick" | "sha1quick" | "none"
    meta_format: "simplejson", // | "none"
    name_format: "*.rclone_chunk.###",
    start_from: 1,
    transactions: "rename", // | "norename" | "auto"
  },
};

/**
 * The options of a request.
 * @typedef {Object} Config
 * @property {string} remote
 * @property {number} chunkSize
 * @property {number} startFrom
 * @property {boolean} useMeta
 * @property {"md5" | "sha1" | ""} hash
 * @property {boolean} hashAll True to write metadata for each file.
 * @property {boolean} noRename True for the transactions "norename".
 * @property {boolean} failHard
 * @property {ReturnType<typeof nameFormat>} names
 */

/**
 * Sends the requests to the remote under the chunker with the global
 * `fetch`.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function chunker(request) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);

  /** @type {Config} */
  let config;
  try {
    config = configOf(searchParams);
  } catch (error) {
    return new Response(error.message, { status: 400 });
  }
  const path = decodePath(pathname);
  if (path === null) {
    return new Response(null, { status: 400 });
  }

  const slash = path.lastIndexOf("/", path.length - 2) + 1;
  const dir = path.slice(0, slash);
  const name = path.slice(slash);

  if (path.endsWith("/")) {
    if (method === "GET" || method === "HEAD") {
      return await listFolder(config, path, method, `${searchParams}`);
    }
    // A folder is a folder of the remote.
    const response = await send(config, path, {
      method,
      headers: request.headers,
    });
    await response.body?.cancel();
    const headers = new Headers();
    if (method === "PUT" && response.ok) {
      headers.set("Content-Location", pathname);
    }
    return new Response(null, { status: response.status, headers });
  }

  try {
    switch (method) {
      case "GET":
      case "HEAD":
        return await getFile(config, dir, name, method, request);
      case "PUT":
        return await putFile(config, dir, name, request, pathname);
      case "DELETE":
        return await deleteFile(config, dir, name);
    }
  } catch (error) {
    if (!(error instanceof ChunkerError)) throw error;
    return new Response(error.message, { status: error.status });
  }
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET, HEAD, PUT, DELETE" },
  });
}

/** An error with the status of the answer. */
class ChunkerError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(`chunker: ${message}`);
    this.status = status;
  }
}

/**
 * Reads the options, as `NewFs` of the chunker of rclone.
 * @param {URLSearchParams} searchParams
 * @returns {Config}
 */
function configOf(searchParams) {
  const get = (name) => searchParams.get(name) ?? options.default[name];

  const remote = searchParams.get("remote")?.replace(/\/$/, "");
  if (!remote) throw new Error("Missing remote");

  const chunkSize = parseSize(`${get("chunk_size")}`);
  if (chunkSize <= 0) throw new Error("chunk_size must be positive");

  const startFrom = Number(get("start_from"));
  if (!Number.isInteger(startFrom) || startFrom < 0) {
    throw new Error("start_from must be non-negative");
  }

  const metaFormat = get("meta_format");
  if (metaFormat !== "simplejson" && metaFormat !== "none") {
    throw new Error(`unsupported meta format '${metaFormat}'`);
  }
  const useMeta = metaFormat === "simplejson";

  const hashType = get("hash_type");
  const hashes = {
    none: ["", false],
    md5: ["md5", false],
    sha1: ["sha1", false],
    md5quick: ["md5", false],
    sha1quick: ["sha1", false],
    md5all: ["md5", true],
    sha1all: ["sha1", true],
  };
  if (!Object.hasOwn(hashes, hashType)) {
    throw new Error(`unsupported hash type '${hashType}'`);
  }
  const [hash, hashAll] = hashes[hashType];
  if (hash && !useMeta) {
    throw new Error(`hash type '${hashType}' requires compatible meta format`);
  }

  // The backends of rfetch cannot rename, thus "auto" is "norename".
  const transactions = get("transactions");
  if (!["rename", "norename", "auto"].includes(transactions)) {
    throw new Error(`unsupported transaction mode '${transactions}'`);
  }
  const noRename = transactions !== "rename";
  if (noRename && !useMeta) {
    throw new Error("using norename transactions requires metadata");
  }

  return {
    remote,
    chunkSize,
    startFrom,
    useMeta,
    hash,
    hashAll,
    noRename,
    failHard: get("fail_hard") === "true",
    names: nameFormat(get("name_format"), startFrom),
  };
}

/**
 * Makes and reads the names of chunks, as `setChunkNameFormat`,
 * `makeChunkName` and `parseChunkName` of the chunker of rclone.
 * @param {string} pattern For example `*.rclone_chunk.###`.
 * @param {number} startFrom The number of the first chunk.
 */
function nameFormat(pattern, startFrom) {
  if (pattern.split("*").length !== 2) {
    throw new Error("pattern must have exactly one asterisk (*)");
  }
  const digits = pattern.split("#").length - 1;
  if (digits < 1) throw new Error("pattern must have a hash character (#)");
  if (pattern.indexOf("*") > pattern.indexOf("#")) {
    throw new Error("asterisk (*) in pattern must come before hashes (#)");
  }
  if (!/^[^#]*#+[^#]*$/.test(pattern)) {
    throw new Error("hashes (#) in pattern must be consecutive");
  }
  if (pattern.includes("/")) throw new Error("directory separator prohibited");
  if (pattern[0] !== "*") throw new Error("pattern must start with asterisk");

  // The parts of the pattern before and after the number.
  const [before, after] = pattern.split(/#+/);
  const number = digits > 1 ? `[0-9]{${digits},}` : "[0-9]+";
  const source = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/#+/, `(?:(${number})|_(${CTRL_TYPE}))`)
    // A name has no "\n", as "." of Go. Non-greedy, to keep the suffix.
    .replace("\\*", "([^\\n]+?)");
  const regex = new RegExp(
    `^${source}(?:_([0-9a-z]{4,9})|\\.\\.tmp_([0-9]{10,13}))?$`,
  );

  return {
    /**
     * The name of a data chunk, from 0. A transaction gives a suffix.
     * @param {string} main
     * @param {number} chunkNo
     * @param {string} [xact]
     */
    make(main, chunkNo, xact = "") {
      // A "#" in the name of the file is not a part of the pattern.
      const name = before.replace("*", () => main) +
        `${chunkNo + startFrom}`.padStart(digits, "0") + after;
      return xact ? `${name}_${xact.padStart(4, "0")}` : name;
    },
    /**
     * The parts of the name of a chunk, or null for a name that is not a
     * chunk. `chunkNo` is -1 for a control chunk.
     * @param {string} name
     * @returns {{ main: string, chunkNo: number, ctrl: string, xact: string } | null}
     */
    parse(name) {
      const match = regex.exec(name);
      if (!match || !match[1]) return null;
      let chunkNo = -1;
      if (match[2]) {
        chunkNo = Number(match[2]) - startFrom;
        if (chunkNo < 0) return null;
      }
      let xact = match[4] ?? "";
      if (match[5]) {
        // The old suffix of a transaction, as a number in base 36.
        xact = Number(match[5]).toString(36).padStart(4, "0");
      }
      return { main: match[1], chunkNo, ctrl: match[3] ?? "", xact };
    },
  };
}

/**
 * Gives the entries of a folder of the remote, or null when the folder does
 * not exist.
 * @param {Config} config
 * @param {string} dir The path of the folder, with "/" at the end.
 */
async function listRemote(config, dir) {
  const response = await send(config, dir);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ChunkerError(`the list of ${dir} gave ${response.status}`, 502);
  }
  return await readListing(response, new URL(encodePath(dir), "http://remote"));
}

/**
 * A file of the chunker: a file of the remote, or a composite file of data
 * chunks.
 * @typedef {Object} ChunkedFile
 * @property {string} name
 * @property {import("../../lib/listing.js").Entry | undefined} main The
 *   file with the name on the remote: the file, or its metadata.
 * @property {import("../../lib/listing.js").Entry[] | null} chunks The data
 *   chunks in their order, or null for a file that is not composite.
 * @property {number} size
 * @property {string} modTime
 */

/**
 * Groups the entries of a folder of the remote into folders and files, as
 * `processEntries` of the chunker of rclone. A file with missing chunks is
 * not in the result.
 * @param {Config} config
 * @param {import("../../lib/listing.js").Entry[]} entries
 * @param {(name: string) => Promise<Metadata | null>} metadataOf Reads the
 *   metadata of a file, for a composite file of a transaction.
 */
async function group(config, entries, metadataOf) {
  /** @type {Map<string, import("../../lib/listing.js").Entry>} */
  const mains = new Map();
  /** @type {Map<string, Map<string, import("../../lib/listing.js").Entry[]>>} */
  const chunks = new Map();
  const folders = [];

  for (const entry of entries) {
    if (entry.IsDir) {
      folders.push(entry);
      continue;
    }
    const parsed = config.names.parse(entry.Name);
    if (!parsed) {
      mains.set(entry.Name, entry);
    } else if (!parsed.ctrl) {
      if (!chunks.has(parsed.main)) chunks.set(parsed.main, new Map());
      const byXact = chunks.get(parsed.main);
      if (!byXact.has(parsed.xact)) byXact.set(parsed.xact, []);
      byXact.get(parsed.xact)[parsed.chunkNo] = entry;
    }
  }

  /** @type {ChunkedFile[]} */
  const files = [];
  const names = new Set([
    ...mains.keys(),
    ...(config.useMeta ? [] : chunks.keys()),
  ]);
  for (const name of names) {
    const main = mains.get(name);
    const byXact = chunks.get(name);
    let active = byXact?.get("");

    if (config.useMeta && byXact && !active && main.Size <= MAX_METADATA_SIZE) {
      // The chunks of a "norename" transaction have its suffix.
      const xact = (await metadataOf(name))?.txn;
      if (xact) active = byXact.get(xact);
    }

    if (!active) {
      if (main) {
        files.push({
          name,
          main,
          chunks: null,
          size: main.Size,
          modTime: main.ModTime,
        });
      }
      continue;
    }
    // The metadata of a composite file is small, and no chunk is missing.
    if (config.useMeta && main.Size > MAX_METADATA_SIZE) continue;
    if (active.length > MAX_CHUNKS || active.includes(undefined)) continue;
    files.push({
      name,
      main,
      chunks: active,
      size: active.reduce((total, chunk) => total + chunk.Size, 0),
      modTime: (main ?? active[0]).ModTime,
    });
  }
  return { folders, files };
}

/**
 * Reads and checks metadata, as `unmarshalSimpleJSON` of rclone. It gives
 * null for a file that rclone does not take as metadata.
 * @param {Uint8Array} data
 * @returns {Metadata | null}
 * @throws {ChunkerError} For metadata of a newer version of rclone.
 */
function readMetadata(data) {
  if (data.length > MAX_METADATA_SIZE_WRITTEN) return null;
  if (data.length < 2 || data[0] !== 0x7b || data.at(-1) !== 0x7d) return null;
  let metadata;
  try {
    metadata = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data),
    );
  } catch {
    return null;
  }
  if (typeof metadata !== "object" || metadata === null) return null;
  const { ver, size, nchunks, md5, sha1, txn } = metadata;
  const integer = (value) => Number.isInteger(value);
  if (!integer(ver) || !integer(size) || !integer(nchunks)) return null;
  if (ver < 1 || size < 0 || nchunks < 0) return null;
  if (nchunks > MAX_CHUNKS) {
    throw new ChunkerError("chunk number overflow", 500);
  }
  if (md5 !== undefined && md5 !== "" && !/^[0-9a-fA-F]{32}$/.test(md5)) {
    return null;
  }
  if (sha1 !== undefined && sha1 !== "" && !/^[0-9a-fA-F]{40}$/.test(sha1)) {
    return null;
  }
  if (nchunks < 1 && ver <= METADATA_VERSION) return null;
  if (ver > METADATA_VERSION) {
    throw new ChunkerError("unknown metadata, please upgrade rclone", 500);
  }
  return {
    ver,
    size,
    nchunks,
    md5,
    sha1,
    txn: typeof txn === "string" ? txn : "",
  };
}

/**
 * Writes metadata, as `marshalSimpleJSON` of rclone.
 * @param {number} size
 * @param {number} nchunks
 * @param {{ md5?: string, sha1?: string }} hashes
 * @param {string} xact
 */
function writeMetadata(size, nchunks, { md5, sha1 }, xact) {
  const metadata = { ver: xact ? METADATA_VERSION : 1, size, nchunks };
  if (md5) metadata.md5 = md5;
  if (sha1) metadata.sha1 = sha1;
  if (xact) metadata.txn = xact;
  return new TextEncoder().encode(JSON.stringify(metadata));
}

/**
 * Gives a function that reads the metadata of the files of a folder.
 * @param {Config} config
 * @param {string} dir
 */
function metadataReader(config, dir) {
  return async (name) => {
    const response = await send(config, dir + name);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return readMetadata(new Uint8Array(await response.arrayBuffer()));
  };
}

/**
 * Gives the list of a folder, with the composite files and no chunk.
 * @param {Config} config
 * @param {string} path
 * @param {string} method
 * @param {string} query
 */
async function listFolder(config, path, method, query) {
  let entries;
  try {
    entries = await listRemote(config, path);
  } catch (error) {
    if (!(error instanceof ChunkerError)) throw error;
    return new Response(error.message, { status: error.status });
  }
  if (!entries) {
    return new Response(null, { status: 404 });
  }
  const headers = { "Content-Type": "text/html;charset=utf-8" };
  if (method === "HEAD") {
    return new Response(null, { headers });
  }
  const { folders, files } = await group(
    config,
    entries,
    metadataReader(config, path),
  );
  const list = [
    ...folders,
    ...files.map(({ name, size, modTime }) => ({
      Name: name,
      IsDir: false,
      Size: size,
      MimeType: mimeType(name),
      ModTime: modTime,
    })),
  ];
  return new Response(renderListing(list, { query }), { headers });
}

/**
 * Gives the entries of the remote for a file: the file with the name, and
 * its chunks.
 * @param {Config} config
 * @param {string} dir
 * @param {string} name
 */
async function ownEntries(config, dir, name) {
  return (await listRemote(config, dir) ?? []).filter((entry) =>
    !entry.IsDir &&
    (entry.Name === name || config.names.parse(entry.Name)?.main === name)
  );
}

/**
 * Finds a file of the chunker in its folder, and checks the metadata of a
 * composite file, as `readMetadata` of rclone.
 * @param {Config} config
 * @param {string} dir
 * @param {string} name
 * @returns {Promise<{ file: ChunkedFile | null }>}
 */
async function findFile(config, dir, name) {
  const own = await ownEntries(config, dir, name);
  const readMeta = metadataReader(config, dir);
  /** @type {Map<string, Metadata | null>} */
  const read = new Map();
  const metadataOf = async (name) => {
    if (!read.has(name)) read.set(name, await readMeta(name));
    return read.get(name);
  };

  const { files } = await group(config, own, metadataOf);
  let file = files.find((file) => file.name === name) ?? null;

  if (file?.chunks && config.useMeta) {
    const metadata = await metadataOf(name);
    if (!metadata) {
      throw new ChunkerError(`invalid metadata of ${name}`, 500);
    }
    if (
      metadata.size !== file.size || metadata.nchunks !== file.chunks.length
    ) {
      throw new ChunkerError("metadata doesn't match file size", 500);
    }
  }
  // A list does not show a composite file with a missing chunk, but a read
  // of it is an error, as in rclone.
  const main = own.some((entry) => entry.Name === name);
  const chunks = own.some((entry) => {
    const parsed = config.names.parse(entry.Name);
    return parsed && !parsed.ctrl && !parsed.xact;
  });
  if (!file && chunks && (main || !config.useMeta)) {
    throw new ChunkerError(`${name} has missing chunks`, 500);
  }
  return { file };
}

/**
 * @param {Config} config
 * @param {string} dir
 * @param {string} name
 * @param {string} method
 * @param {Request} request Its `Range` gives a range of the file.
 */
async function getFile(config, dir, name, method, request) {
  const { file } = await findFile(config, dir, name);
  if (!file) {
    return new Response(null, { status: 404 });
  }
  const header = method === "GET" ? request.headers.get("Range") : null;
  if (!file.chunks) {
    // A file of the remote, with the range of the request.
    return await send(config, dir + name, {
      method,
      headers: header === null ? {} : { Range: header },
    });
  }

  const headers = new Headers({
    "Content-Type": mimeType(name),
    "Content-Length": `${file.size}`,
    "Accept-Ranges": "bytes",
  });
  if (file.modTime) {
    headers.set("Last-Modified", new Date(file.modTime).toUTCString());
  }
  if (method === "HEAD") {
    return new Response(null, { headers });
  }

  let range;
  try {
    range = parseRange(header, file.size);
  } catch {
    return notSatisfiable(file.size);
  }
  const { start, end } = range ?? { start: 0, end: file.size - 1 };
  // The chunks in the range, with the part of each chunk in the range.
  /** @type {Array<{ path: string, from: number, to: number, size: number }>} */
  const parts = [];
  let offset = 0;
  for (const chunk of file.chunks) {
    const first = offset;
    const last = offset + chunk.Size - 1;
    offset += chunk.Size;
    if (last < start || first > end) continue;
    parts.push({
      path: dir + chunk.Name,
      from: Math.max(start, first) - first,
      to: Math.min(end, last) - first,
      size: chunk.Size,
    });
  }
  if (range) {
    for (
      const [name, value] of Object.entries(partialHeaders(range, file.size))
    ) {
      headers.set(name, value);
    }
  }
  const length = file.size === 0 ? 0 : end - start + 1;
  return new Response(sized(concatenate(config, parts), length), {
    status: range ? 206 : 200,
    headers,
  });
}

/**
 * Gives the data of files of the remote, one after the other: from the byte
 * `from` to the byte `to` of each file. A part of a file is a range of the
 * request. When the remote sends all the file, only the part goes out.
 * @param {Config} config
 * @param {Array<{ path: string, from: number, to: number, size: number }>} parts
 * @returns {ReadableStream<Uint8Array>}
 */
function concatenate(config, parts) {
  let index = 0;
  /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
  let reader = null;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (!reader) {
          if (index === parts.length) {
            controller.close();
            return;
          }
          const { path, from, to, size } = parts[index++];
          const whole = from === 0 && to === size - 1;
          const response = await send(config, path, {
            headers: whole ? {} : { Range: `bytes=${from}-${to}` },
          });
          if (!response.ok || !response.body) {
            throw new Error(`chunker: chunk ${index} gave ${response.status}`);
          }
          let body = response.body;
          if (!whole && response.status !== 206) {
            body = sliceStream(body, from, to - from + 1);
          }
          reader = body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
    cancel(reason) {
      return reader?.cancel(reason);
    },
  });
}

/**
 * Puts a file: a file of the remote when it fits in one chunk, else data
 * chunks and metadata, as `put` of the chunker of rclone.
 *
 * rclone puts the chunks with temporary names and then renames them. The
 * backends of rfetch cannot rename. Thus with the transactions "rename" the
 * chunks get their last names at once, and a reader can see a file that is
 * not complete. With "norename", the chunks have the suffix of the
 * transaction, and the file changes only when the metadata changes.
 * @param {Config} config
 * @param {string} dir
 * @param {string} name
 * @param {Request} request
 * @param {string} pathname
 */
async function putFile(config, dir, name, request, pathname) {
  const header = request.headers.get("Content-Length");
  let length = header !== null && /^\d+$/.test(header) ? Number(header) : null;
  const old = await ownEntries(config, dir, name);

  const source = new Source(request.body);
  if (length === null) {
    // A small file of unknown size is a file of known size.
    const head = await source.peek(Math.min(config.chunkSize, 2 ** 20) + 1);
    if (head.done) length = head.size;
  }

  // A small file with the content of metadata needs metadata, else rclone
  // takes it as metadata.
  let single = length !== null && length <= config.chunkSize &&
    config.useMeta && !config.hashAll;
  if (single && length <= MAX_METADATA_SIZE) {
    const head = await source.peek(length);
    try {
      single = readMetadata(head.bytes) === null;
    } catch {
      single = false;
    }
  }

  /** @type {Set<string>} The names of the new version. */
  const written = new Set();
  if (single) {
    const headers = new Headers();
    const type = request.headers.get("Content-Type");
    if (type) headers.set("Content-Type", type);
    headers.set("Content-Length", `${length}`);
    await put(config, dir + name, source.take(length), headers);
    await source.end(length);
    written.add(name);
  } else {
    const xact = config.noRename ? newXactID() : "";
    const hash = config.hash ? createHash(config.hash) : null;
    let size = 0;
    let chunkNo = 0;
    do {
      if (chunkNo >= MAX_CHUNKS) throw new ChunkerError("chunk overflow", 413);
      const chunkName = config.names.make(name, chunkNo, xact);
      const chunkSize = length === null
        ? config.chunkSize
        : Math.min(config.chunkSize, length - size);
      const headers = new Headers();
      if (length !== null) headers.set("Content-Length", `${chunkSize}`);
      const before = source.count;
      await put(config, dir + chunkName, source.take(chunkSize, hash), headers);
      size += source.count - before;
      written.add(chunkName);
      chunkNo++;
    } while (length === null ? !(await source.peek(1)).done : size < length);
    if (length !== null) await source.end(length);

    if (config.useMeta) {
      const hashes = hash ? { [config.hash]: hash.digest("hex") } : {};
      const metadata = writeMetadata(size, chunkNo, hashes, xact);
      await put(
        config,
        dir + name,
        new Blob([metadata]).stream(),
        new Headers({
          "Content-Type": "application/json",
          "Content-Length": `${metadata.length}`,
        }),
      );
      written.add(name);
    }
  }

  // The chunks of the old version go away.
  for (const entry of old) {
    if (!written.has(entry.Name)) {
      await remove(config, dir + entry.Name);
    }
  }

  return new Response(null, {
    status: 201,
    headers: { "Content-Location": pathname },
  });
}

/**
 * @param {Config} config
 * @param {string} dir
 * @param {string} name
 */
async function deleteFile(config, dir, name) {
  // No check of the chunks: a file with a missing chunk can go away too.
  const entries = await ownEntries(config, dir, name);
  if (!entries.length) {
    return new Response(null, { status: 404 });
  }
  // The metadata first: then the file is not there, also when a chunk
  // stays.
  entries.sort((a, b) => (b.Name === name) - (a.Name === name));
  for (const entry of entries) {
    await remove(config, dir + entry.Name);
  }
  return new Response(null, { status: 204 });
}

/**
 * Sends a request to the remote under the chunker.
 * @param {Config} config
 * @param {string} path The path in the remote, with no percent-encoding.
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
function send(config, path, init) {
  return fetch(config.remote + encodePath(path), init);
}

/**
 * Puts a body on the remote, or throws.
 * @param {Config} config
 * @param {string} path
 * @param {ReadableStream<Uint8Array>} body
 * @param {Headers} headers
 */
async function put(config, path, body, headers) {
  const response = await send(config, path, {
    method: "PUT",
    headers,
    body,
    duplex: "half",
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new ChunkerError(`PUT of a chunk gave ${response.status}`, 502);
  }
}

/** @param {Config} config @param {string} path */
async function remove(config, path) {
  const response = await send(config, path, { method: "DELETE" });
  await response.body?.cancel();
}

/**
 * A transaction ID: 6 characters in base 36, as `newXactID` of rclone.
 */
function newXactID() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => (byte % 36).toString(36)).join("");
}

/**
 * The body of a request, which gives its bytes in parts of a size.
 */
class Source {
  /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
  #reader;
  /** @type {Uint8Array[]} The bytes that came back after a peek. */
  #pending = [];
  /** The number of bytes that `take` gave. */
  count = 0;

  /** @param {ReadableStream<Uint8Array> | null} body */
  constructor(body) {
    this.#reader = body?.getReader() ?? null;
  }

  /** @returns {Promise<Uint8Array | null>} */
  async #read() {
    if (this.#pending.length) return this.#pending.shift();
    if (!this.#reader) return null;
    const { done, value } = await this.#reader.read();
    if (done) {
      this.#reader = null;
      return null;
    }
    return value;
  }

  /**
   * Reads up to `size` bytes and gives them back to the source.
   * @param {number} size
   * @returns {Promise<{ bytes: Uint8Array, size: number, done: boolean }>}
   */
  async peek(size) {
    const parts = [];
    let total = 0;
    let done = false;
    while (total < size) {
      const part = await this.#read();
      if (!part) {
        done = true;
        break;
      }
      parts.push(part);
      total += part.length;
    }
    this.#pending.unshift(...parts);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return { bytes: bytes.subarray(0, size), size: total, done };
  }

  /**
   * Gives a stream of the next `size` bytes, or less at the end.
   * @param {number} size
   * @param {import("node:crypto").Hash | null} [hash]
   * @returns {ReadableStream<Uint8Array>}
   */
  take(size, hash = null) {
    let left = size;
    return new ReadableStream({
      pull: async (controller) => {
        const part = left > 0 ? await this.#read() : null;
        if (!part) {
          controller.close();
          return;
        }
        const bytes = part.length > left ? part.subarray(0, left) : part;
        if (part.length > left) this.#pending.unshift(part.subarray(left));
        left -= bytes.length;
        this.count += bytes.length;
        hash?.update(bytes);
        controller.enqueue(bytes);
      },
    });
  }

  /**
   * Makes sure that the body had the size of its Content-Length.
   * @param {number} size
   */
  async end(size) {
    if (this.count !== size || !(await this.peek(1)).done) {
      throw new ChunkerError(
        `incorrect upload size ${this.count} != ${size}`,
        400,
      );
    }
  }
}

export default {
  fetch: chunker,
};
