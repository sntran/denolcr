/**
 * Amazon S3 Backend
 *
 * The s3 backend reads and writes the objects of Amazon S3, and of the
 * services that are compatible with S3, for example Cloudflare R2, MinIO and
 * `rclone serve s3`, as the s3 backend of rclone.
 *
 * A path is `/bucket/path/to/file`. The path `/` is the list of the
 * buckets, and `/bucket/` is the root of a bucket.
 *
 * The options, with the names of rclone:
 *
 * - `access_key_id`, `secret_access_key` and `session_token`: the
 *   credentials. With no credentials, the requests have no signature. These
 *   options are not in the links of a list, because they are secret.
 * - `region`: `us-east-1` by default. For Cloudflare R2, `auto`.
 * - `endpoint`: the URL of the service, by default the URL of Amazon S3 for
 *   the region.
 * - `force_path_style`: `true` by default, for the URL
 *   `ENDPOINT/bucket/key`. With `false`, the URL is `bucket.ENDPOINT/key`.
 * - `upload_cutoff`: 200 MiB by default. A file of a known size up to this
 *   size goes in one PUT. A larger file, or a file of unknown size that is
 *   larger than `chunk_size`, goes in parts.
 * - `chunk_size`: 5 MiB by default, the size of a part.
 * - `list_chunk`: 1000 by default, the number of objects of each list.
 * - `list_url_encode`: `true` by default. The service puts the
 *   percent-encoding in the names of a list, thus a name can have control
 *   characters.
 * - `directory_markers`: `false` by default, thus a folder exists only when
 *   it has a file, as in rclone. With `true`, the PUT of a folder or of a
 *   file puts a marker for the folder and for each parent folder that has
 *   no marker. A marker is an empty object with the name of the folder and
 *   a `/`, thus a folder can be empty.
 *
 * Each option can also come from a header or from `env`, with the name of
 * the variable of rfetch, for example `RFETCH_S3_SECRET_ACCESS_KEY`, or of
 * rclone, `RCLONE_S3_SECRET_ACCESS_KEY`. Put the credentials in a header or
 * in `env`, not in a URL.
 *
 * As rclone, the backend keeps the time of a file in the metadata `mtime`
 * of the object, from the header `X-OC-Mtime` of a `PUT` or a `COPY`. The
 * `Last-Modified` of `GET` and `HEAD` is that time. The list of a folder
 * gives the time of the upload: a list of S3 does not give the metadata.
 *
 * Other than GET, HEAD, PUT and DELETE, the backend knows:
 *
 * - `COPY` of a file to the path of the header `Destination`, with
 *   CopyObject: the bytes do not go through the backend. A file of more than
 *   4768 MiB gives 501, as CopyObject cannot copy it in one request.
 * - `PATCH` of a file with `X-OC-Mtime`: it sets the time of the file, with
 *   a CopyObject of the object onto itself, as rclone.
 */
import { createHash } from "node:crypto";
import { renderListing } from "@rfetch/lib/listing";
import { mimeType } from "@rfetch/lib/mime";
import { optionsOf } from "@rfetch/lib/options";
import { decodePath } from "@rfetch/lib/path";
import {
  notSatisfiable,
  parseRange,
  partialHeaders,
  sliceStream,
} from "@rfetch/lib/range";
import { parseSize } from "@rfetch/lib/size";
import { sized } from "@rfetch/lib/sized";
import {
  childrenOf,
  escapeXML,
  isXMLText,
  parseXML,
  textOf,
} from "@rfetch/lib/xml";
import { formatUnixTime, modTimeOf, parseUnixTime } from "@rfetch/lib/time";
import { EMPTY_PAYLOAD, sign, UNSIGNED_PAYLOAD, uriEncode } from "./sigv4.js";

/** The name of the metadata of the time of a file, as rclone. */
const MTIME = "x-amz-meta-mtime";

/**
 * The size of the largest file that CopyObject copies, as rclone: less than
 * 5 GiB for Backblaze B2.
 */
const MAX_COPY_SIZE = 4768 * 1024 * 1024;

export const options = {
  string: [
    "access_key_id",
    "secret_access_key",
    "session_token",
    "region",
    "endpoint",
    "upload_cutoff",
    "chunk_size",
    "list_chunk",
  ],
  boolean: ["force_path_style", "list_url_encode", "directory_markers"],
  default: {
    region: "us-east-1",
    upload_cutoff: "200Mi",
    chunk_size: "5Mi",
    list_chunk: "1000",
    force_path_style: "true",
    list_url_encode: "true",
    directory_markers: "false",
  },
};

/** The options that are secret. They are not in the links of a list. */
const SECRETS = ["access_key_id", "secret_access_key", "session_token"];

/** The largest number of parts of an upload in parts. */
const MAX_PARTS = 10000;

/** The smallest size of a part, but not of the last part. */
const MIN_CHUNK_SIZE = 5 * 1024 * 1024;

/**
 * The options of a request.
 * @typedef {Object} Config
 * @property {URL} endpoint
 * @property {boolean} pathStyle
 * @property {{ accessKeyId: string, secretAccessKey: string,
 *   sessionToken?: string, region: string } | null} credentials
 * @property {number} uploadCutoff
 * @property {number} chunkSize
 * @property {number} listChunk
 * @property {boolean} urlEncode
 * @property {boolean} markers
 */

/** An error with the status of the answer. */
class S3Error extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Serves an S3 remote.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options from the variables
 *   `RFETCH_S3_*` or `RCLONE_S3_*`.
 * @returns {Promise<Response>}
 */
async function s3(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);

  let config;
  try {
    config = configOf(request, env);
  } catch (error) {
    return new Response(error.message, { status: 400 });
  }
  const path = decodePath(pathname);
  if (path === null) {
    return new Response(null, { status: 400 });
  }

  const slash = path.indexOf("/", 1);
  const bucket = slash === -1 ? path.slice(1) : path.slice(1, slash);
  const key = slash === -1 ? "" : path.slice(slash + 1);
  const isFolder = path.endsWith("/");
  if (!isFolder && key === "") {
    // A file is in a bucket.
    return new Response(null, { status: method === "PUT" ? 400 : 404 });
  }
  const modTime = modTimeOf(request);
  if (modTime === undefined) {
    return new Response("X-OC-Mtime is not a time", { status: 400 });
  }
  /** The headers of an answer that sets the time of a file. */
  const accepted = modTime === null ? {} : { "X-OC-Mtime": "accepted" };

  try {
    if (method === "GET" || method === "HEAD") {
      if (!isFolder) return await getFile(config, bucket, key, request);
      const query = new URLSearchParams(searchParams);
      for (const name of SECRETS) query.delete(name);
      return await getFolder(config, bucket, key, method, `${query}`);
    }
    if (method === "PUT") {
      if (bucket === "") {
        return new Response(null, { status: 405, headers: { Allow: "GET" } });
      }
      await (isFolder
        ? putFolder(config, bucket, key)
        : putFile(config, bucket, key, request, modTime));
      return new Response(null, {
        status: 201,
        headers: {
          "Content-Location": pathname,
          ...(isFolder ? {} : accepted),
        },
      });
    }
    if (method === "COPY" && !isFolder) {
      const target = decodePath(request.headers.get("Destination") ?? "");
      const end = target?.indexOf("/", 1) ?? -1;
      if (target === null || end === -1 || end === target.length - 1) {
        return new Response("Destination is not a file", { status: 400 });
      }
      if (target.endsWith("/")) {
        return new Response("Destination is a folder", { status: 409 });
      }
      await copyFile(config, { bucket, key }, {
        bucket: target.slice(1, end),
        key: target.slice(end + 1),
      }, modTime);
      return new Response(null, { status: 201, headers: accepted });
    }
    if (method === "PATCH" && !isFolder) {
      if (modTime === null) {
        return new Response("X-OC-Mtime is missing", { status: 400 });
      }
      await copyFile(config, { bucket, key }, { bucket, key }, modTime);
      return new Response(null, { status: 204, headers: accepted });
    }
    if (method === "DELETE") {
      if (bucket === "") {
        return new Response(null, { status: 405, headers: { Allow: "GET" } });
      }
      await (isFolder
        ? deleteFolder(config, bucket, key)
        : deleteFile(config, bucket, key));
      return new Response(null, { status: 204 });
    }
  } catch (error) {
    if (error instanceof S3Error) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
  await request.body?.cancel();
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET, HEAD, PUT, DELETE, COPY, PATCH" },
  });
}

/**
 * Reads the options of a request, as `NewFs` of the s3 backend of rclone.
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @returns {Config}
 * @throws {Error} When an option is not correct.
 */
function configOf(request, env) {
  const values = optionsOf(request, "s3", env);
  /** @param {string} name */
  const get = (name) => values.get(name) ?? options.default[name] ?? "";
  const region = get("region") || "us-east-1";
  let endpoint = get("endpoint") ||
    `https://s3.${region}.amazonaws.com`;
  if (!/^https?:\/\//i.test(endpoint)) endpoint = `https://${endpoint}`;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("The endpoint is not a URL");
  }

  const accessKeyId = get("access_key_id");
  const secretAccessKey = get("secret_access_key");
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error("access_key_id and secret_access_key go together");
  }
  const sessionToken = get("session_token");

  const chunkSize = parseSize(get("chunk_size"));
  if (chunkSize < MIN_CHUNK_SIZE) {
    throw new Error("chunk_size must be at least 5 MiB");
  }
  const listChunk = Number(get("list_chunk"));
  if (!Number.isInteger(listChunk) || listChunk < 1) {
    throw new Error("list_chunk must be a number of 1 or more");
  }

  return {
    endpoint: url,
    pathStyle: get("force_path_style") !== "false",
    credentials: accessKeyId
      ? { accessKeyId, secretAccessKey, sessionToken, region }
      : null,
    uploadCutoff: parseSize(get("upload_cutoff")),
    chunkSize,
    listChunk,
    urlEncode: get("list_url_encode") !== "false",
    markers: get("directory_markers") === "true",
  };
}

/**
 * Sends a request to S3, with the signature of the credentials.
 * @param {Config} config
 * @param {string} method
 * @param {string} bucket "" for the service.
 * @param {string} key "" for the bucket.
 * @param {Object} [init]
 * @param {Record<string, string>} [init.query]
 * @param {Record<string, string>} [init.headers]
 * @param {BodyInit | null} [init.body]
 * @param {number} [init.length] The size of the body.
 * @param {string} [init.payload] The SHA-256 of the body, else the body has
 *   no signature.
 * @returns {Promise<Response>}
 * @throws {S3Error} When the service does not answer.
 */
async function send(
  config,
  method,
  bucket,
  key,
  { query = {}, headers = {}, body = null, length, payload } = {},
) {
  const url = new URL(config.endpoint);
  let path = url.pathname.replace(/\/$/, "");
  if (bucket && !config.pathStyle) {
    url.hostname = `${bucket}.${url.hostname}`;
  } else if (bucket) {
    path += `/${uriEncode(bucket)}`;
  }
  if (key) path += `/${uriEncode(key, true)}`;
  url.pathname = path || "/";
  // The query has the encoding of AWS, as the signature.
  url.search = Object.entries(query)
    .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
    .join("&");

  let signed = new Headers(headers);
  if (config.credentials) {
    signed = sign({
      method,
      url,
      headers: signed,
      payload: payload ?? (body === null ? EMPTY_PAYLOAD : UNSIGNED_PAYLOAD),
    }, config.credentials);
  }
  if (length !== undefined) signed.set("Content-Length", `${length}`);
  // The size of a file is the size of its body: a service such as R2 can
  // compress a text file for a client that accepts gzip.
  signed.set("Accept-Encoding", "identity");

  /** @type {RequestInit} */
  const init = { method, headers: signed };
  if (body !== null) {
    init.body = body;
    if (body instanceof ReadableStream) init.duplex = "half";
  }
  try {
    return await fetch(url, init);
  } catch {
    throw new S3Error("The S3 service did not answer", 502);
  }
}

/**
 * Makes sure that an answer of S3 is a success, else throws its error.
 * @param {Response} response
 * @returns {Promise<Response>}
 * @throws {S3Error}
 */
async function check(response) {
  if (response.ok) return response;
  const text = await response.text();
  let code = "";
  try {
    code = textOf(parseXML(text), "Code");
  } catch {
    // An answer with no XML, for example of HEAD.
  }
  throw new S3Error(code || response.statusText, response.status);
}

/**
 * Reads a name of a list, as rclone: with no percent-encoding when the
 * list has the encoding `url`. As `url.QueryUnescape` of Go, a `+` is a
 * space.
 * @param {string} name
 * @param {boolean} encoded
 * @returns {string | null} null for an encoding that is not correct.
 */
function nameOf(name, encoded) {
  if (!encoded) return name;
  try {
    return decodeURIComponent(name.replaceAll("+", " "));
  } catch {
    return null;
  }
}

/**
 * Gets a file, or only its headers for HEAD, with the range of the request.
 *
 * S3 gets a range that is correct, and its answer 206 goes to the client.
 * When the service does not give a 206 with `Content-Range`, the backend
 * makes the answer of RFC 9110 with the size of a HEAD request: some
 * services, for example `rclone serve s3`, give the bytes of a range with
 * 200.
 * @param {Config} config
 * @param {string} bucket
 * @param {string} key
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function getFile(config, bucket, key, request) {
  const { method } = request;
  const header = method === "GET" ? request.headers.get("Range") : null;
  let range = null;
  try {
    // Only the form of the range: the size is not known yet.
    range = parseRange(header, Number.MAX_SAFE_INTEGER);
  } catch {
    // For example bytes=-0: no byte of a file is in the range.
    return await getRange(config, bucket, key, header);
  }
  if (range) {
    const response = await send(config, "GET", bucket, key, {
      headers: { Range: header },
    });
    if (response.status === 206 && response.headers.has("Content-Range")) {
      return fileResponse(response, key);
    }
    await response.body?.cancel();
    if (response.ok || response.status === 416) {
      return await getRange(config, bucket, key, header);
    }
    return new Response(null, { status: response.status });
  }
  const response = await send(config, method, bucket, key);
  if (!response.ok) {
    await response.body?.cancel();
    return new Response(null, { status: response.status });
  }
  return fileResponse(response, key, method === "HEAD");
}

/**
 * Gets a range of a file with the size of a HEAD request, as RFC 9110.
 * @param {Config} config
 * @param {string} bucket
 * @param {string} key
 * @param {string} header The `Range` of the request.
 * @returns {Promise<Response>}
 */
async function getRange(config, bucket, key, header) {
  const head = await send(config, "HEAD", bucket, key);
  await head.body?.cancel();
  if (!head.ok) return new Response(null, { status: head.status });
  const size = Number(head.headers.get("Content-Length"));
  let range;
  try {
    range = parseRange(header, size);
  } catch {
    return notSatisfiable(size);
  }
  if (!range) {
    const response = await send(config, "GET", bucket, key);
    if (!response.ok) {
      await response.body?.cancel();
      return new Response(null, { status: response.status });
    }
    return fileResponse(response, key);
  }

  const response = await send(config, "GET", bucket, key, {
    headers: { Range: `bytes=${range.start}-${range.end}` },
  });
  if (!response.ok) {
    await response.body?.cancel();
    return new Response(null, { status: response.status });
  }
  const length = range.end - range.start + 1;
  let body = response.body;
  // A service that sends all the file sends the bytes before the range too.
  if (
    Number(response.headers.get("Content-Length")) === size && size !== length
  ) {
    body = sliceStream(body, range.start, length);
  }
  const result = fileHeaders(response, key);
  for (const [name, value] of Object.entries(partialHeaders(range, size))) {
    result.set(name, value);
  }
  return new Response(sized(body, length), { status: 206, headers: result });
}

/**
 * The answer for a file, with the headers of the answer of S3.
 * @param {Response} response
 * @param {string} key
 * @param {boolean} [head] True for no body.
 * @returns {Response}
 */
function fileResponse(response, key, head = false) {
  const headers = fileHeaders(response, key);
  if (head) {
    response.body?.cancel();
    return new Response(null, { headers });
  }
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The headers of a file, from the answer of S3.
 * @param {Response} response
 * @param {string} key
 * @returns {Headers}
 */
function fileHeaders(response, key) {
  const headers = new Headers({
    "Content-Type": response.headers.get("Content-Type") || mimeType(key),
    "Accept-Ranges": "bytes",
  });
  for (const name of ["Content-Length", "Content-Range", "Last-Modified"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The time of the file, as rclone: the metadata, else the time of the
  // upload.
  const modTime = parseUnixTime(response.headers.get(MTIME));
  if (modTime !== undefined) {
    headers.set(
      "Last-Modified",
      new Date(Number(modTime / 1000000n)).toUTCString(),
    );
  }
  return headers;
}

/**
 * Gets the list of a folder, or only its headers for HEAD.
 * @param {Config} config
 * @param {string} bucket "" for the list of the buckets.
 * @param {string} prefix The path of the folder in the bucket, with a `/`
 *   at the end, or "" for the root of the bucket.
 * @param {string} method
 * @param {string} query The query of each link.
 * @returns {Promise<Response>}
 */
async function getFolder(config, bucket, prefix, method, query) {
  const entries = bucket === ""
    ? await listBuckets(config)
    : await listFolder(config, bucket, prefix);
  if (entries === null) return new Response(null, { status: 404 });
  const headers = { "Content-Type": "text/html;charset=utf-8" };
  if (method === "HEAD") return new Response(null, { headers });
  return new Response(renderListing(entries, { query }), { headers });
}

/**
 * The buckets, as folders.
 * @param {Config} config
 * @returns {Promise<import("@rfetch/lib/listing").Entry[]>}
 */
async function listBuckets(config) {
  const response = await check(await send(config, "GET", "", ""));
  const root = parseXML(await response.text());
  return childrenOf(childrenOf(root, "Buckets")[0], "Bucket").map((bucket) => ({
    Name: textOf(bucket, "Name"),
    IsDir: true,
    Size: -1,
    MimeType: "",
    ModTime: textOf(bucket, "CreationDate"),
  }));
}

/**
 * The files and the folders in a folder, as `list` of the s3 backend of
 * rclone with a delimiter.
 * @param {Config} config
 * @param {string} bucket
 * @param {string} prefix "" for the root of the bucket.
 * @returns {Promise<import("@rfetch/lib/listing").Entry[] | null>} null when
 *   the folder does not exist.
 */
async function listFolder(config, bucket, prefix) {
  /** @type {import("@rfetch/lib/listing").Entry[]} */
  const entries = [];
  let found = false;
  let token = "";
  do {
    const query = {
      "list-type": "2",
      delimiter: "/",
      prefix,
      "max-keys": `${config.listChunk}`,
    };
    if (config.urlEncode) query["encoding-type"] = "url";
    if (token) query["continuation-token"] = token;
    const response = await send(config, "GET", bucket, "", { query });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    const root = parseXML(await (await check(response)).text());
    const encoded = textOf(root, "EncodingType") === "url";

    for (const common of childrenOf(root, "CommonPrefixes")) {
      const name = nameOf(textOf(common, "Prefix"), encoded);
      if (name === null || !name.startsWith(prefix)) continue;
      found = true;
      const folder = name.slice(prefix.length).replace(/\/$/, "");
      if (folder === "") continue;
      entries.push({
        Name: folder,
        IsDir: true,
        Size: -1,
        MimeType: "",
        ModTime: "",
      });
    }
    for (const object of childrenOf(root, "Contents")) {
      const name = nameOf(textOf(object, "Key"), encoded);
      if (name === null || !name.startsWith(prefix)) continue;
      found = true;
      const file = name.slice(prefix.length);
      // The marker of the folder is not a file in it.
      if (file === "" || file.endsWith("/")) continue;
      entries.push({
        Name: file,
        IsDir: false,
        Size: Number(textOf(object, "Size")),
        MimeType: mimeType(file),
        ModTime: textOf(object, "LastModified"),
      });
    }
    token = textOf(root, "IsTruncated") === "true"
      ? textOf(root, "NextContinuationToken")
      : "";
  } while (token);

  // The root of a bucket exists with no file. An empty folder exists when it
  // has a marker, as rclone checks it.
  if (!found && prefix !== "") {
    const response = await send(config, "HEAD", bucket, prefix);
    await response.body?.cancel();
    if (!response.ok) return null;
  }
  return entries;
}

/**
 * Makes a bucket, or a marker of a folder with the option
 * `directory_markers`. With no marker, a folder exists when it has a file.
 * @param {Config} config
 * @param {string} bucket
 * @param {string} prefix
 */
async function putFolder(config, bucket, prefix) {
  if (prefix === "") {
    const head = await send(config, "HEAD", bucket, "");
    await head.body?.cancel();
    if (head.ok) return;
    const response = await send(config, "PUT", bucket, "", {
      body: new Uint8Array(0),
      length: 0,
      payload: EMPTY_PAYLOAD,
    });
    await check(response);
    await response.body?.cancel();
    return;
  }
  if (config.markers) await putMarkers(config, bucket, prefix);
}

/**
 * Puts the markers of a folder and of its parent folders, as rclone: from
 * the folder to the root of the bucket, until a marker exists.
 * @param {Config} config
 * @param {string} bucket
 * @param {string} prefix The folder, with a `/` at the end.
 */
async function putMarkers(config, bucket, prefix) {
  while (prefix !== "") {
    const head = await send(config, "HEAD", bucket, prefix);
    await head.body?.cancel();
    if (head.ok) return;
    const response = await send(config, "PUT", bucket, prefix, {
      body: new Uint8Array(0),
      length: 0,
      payload: EMPTY_PAYLOAD,
    });
    await check(response);
    await response.body?.cancel();
    prefix = prefix.slice(0, prefix.lastIndexOf("/", prefix.length - 2) + 1);
  }
}

/**
 * Puts a file: in one PUT up to `upload_cutoff`, else in parts, as rclone.
 * With `directory_markers`, the parent folders get markers first.
 * @param {Config} config
 * @param {string} bucket
 * @param {string} key
 * @param {Request} request
 * @param {bigint | null} modTime The time of the file, in the metadata
 *   `mtime`, or null.
 */
async function putFile(config, bucket, key, request, modTime) {
  if (config.markers) {
    await putMarkers(config, bucket, key.slice(0, key.lastIndexOf("/") + 1));
  }
  const header = request.headers.get("Content-Length");
  const length = header !== null && /^\d+$/.test(header)
    ? Number(header)
    : null;
  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": request.headers.get("Content-Type") || mimeType(key),
  };
  if (modTime !== null) headers[MTIME] = formatUnixTime(modTime);

  if (length !== null && length <= config.uploadCutoff) {
    const body = sized(request.body ?? new Blob([]).stream(), length);
    const response = await send(config, "PUT", bucket, key, {
      headers,
      body,
      length,
    });
    await check(response);
    await response.body?.cancel();
    return;
  }

  // A part has the size of chunk_size, or more for a large file.
  const partSize = length === null
    ? config.chunkSize
    : Math.max(config.chunkSize, Math.ceil(length / MAX_PARTS));
  const parts = new Parts(request.body ?? new Blob([]).stream(), partSize);
  const first = await parts.next();
  if (length === null && parts.done) {
    // A small file of unknown size.
    const response = await send(config, "PUT", bucket, key, {
      headers,
      body: first,
      length: first.length,
      payload: sha256(first),
    });
    await check(response);
    await response.body?.cancel();
    return;
  }

  const create = await check(
    await send(config, "POST", bucket, key, {
      query: { uploads: "" },
      headers,
    }),
  );
  const uploadId = textOf(parseXML(await create.text()), "UploadId");
  const upload = { uploadId };
  try {
    /** @type {string[]} */
    const etags = [];
    for (let part = first; part; part = await parts.next()) {
      if (etags.length === MAX_PARTS) {
        throw new S3Error("too many parts", 413);
      }
      const response = await check(
        await send(config, "PUT", bucket, key, {
          query: { partNumber: `${etags.length + 1}`, ...upload },
          body: part,
          length: part.length,
          payload: sha256(part),
        }),
      );
      await response.body?.cancel();
      etags.push(response.headers.get("ETag") ?? "");
      if (parts.done) break;
    }
    const xml = new TextEncoder().encode(
      `<CompleteMultipartUpload>${
        etags.map((etag, index) =>
          `<Part><PartNumber>${index + 1}</PartNumber><ETag>${
            escapeXML(etag)
          }</ETag></Part>`
        ).join("")
      }</CompleteMultipartUpload>`,
    );
    const complete = await check(
      await send(config, "POST", bucket, key, {
        query: upload,
        body: xml,
        length: xml.length,
        payload: sha256(xml),
      }),
    );
    // S3 can give an error in an answer 200.
    const result = parseXML(await complete.text());
    if (result.name === "Error") {
      throw new S3Error(textOf(result, "Code"), 502);
    }
  } catch (error) {
    const abort = await send(config, "DELETE", bucket, key, { query: upload });
    await abort.body?.cancel();
    throw error;
  }
}

/**
 * Copies a file with CopyObject, as `Copy` of rclone. With a time, the copy
 * gets the metadata of the source, with that time: a copy onto the same
 * object sets the time of the file, as `SetModTime` of rclone. With no
 * time, the copy keeps the metadata of the source.
 * @param {Config} config
 * @param {{ bucket: string, key: string }} source
 * @param {{ bucket: string, key: string }} target
 * @param {bigint | null} modTime
 * @throws {S3Error} With 404 for a source that does not exist, and with 501
 *   for a file that is too large for CopyObject.
 */
async function copyFile(config, source, target, modTime) {
  const head = await send(config, "HEAD", source.bucket, source.key);
  await head.body?.cancel();
  if (head.status === 404) throw new S3Error("Not Found", 404);
  await check(head);
  if (Number(head.headers.get("Content-Length")) > MAX_COPY_SIZE) {
    throw new S3Error("The file is too large for CopyObject", 501);
  }
  if (config.markers) {
    await putMarkers(
      config,
      target.bucket,
      target.key.slice(0, target.key.lastIndexOf("/") + 1),
    );
  }
  /** @type {Record<string, string>} */
  const headers = {
    "x-amz-copy-source": `/${uriEncode(source.bucket)}/${
      uriEncode(source.key, true)
    }`,
  };
  if (modTime !== null) {
    headers["x-amz-metadata-directive"] = "REPLACE";
    headers["Content-Type"] = head.headers.get("Content-Type") ||
      mimeType(target.key);
    for (const [name, value] of head.headers) {
      if (name.startsWith("x-amz-meta-")) headers[name] = value;
    }
    headers[MTIME] = formatUnixTime(modTime);
  }
  const response = await check(
    await send(config, "PUT", target.bucket, target.key, { headers }),
  );
  // S3 can give an error in an answer 200.
  const text = await response.text();
  if (/<Error>/.test(text)) {
    throw new S3Error(textOf(parseXML(text), "Code"), 502);
  }
}

/**
 * Deletes a file. As the other backends, a file that does not exist gives
 * 404: S3 gives no error for it.
 * @param {Config} config
 * @param {string} bucket
 * @param {string} key
 */
async function deleteFile(config, bucket, key) {
  const head = await send(config, "HEAD", bucket, key);
  await head.body?.cancel();
  if (head.status === 404) throw new S3Error("Not Found", 404);
  await check(head);
  const response = await check(await send(config, "DELETE", bucket, key));
  await response.body?.cancel();
}

/**
 * Deletes a folder and all that is in it, with lists with no delimiter and
 * DeleteObjects of 1000 objects. The root of a bucket deletes the bucket
 * too, as `rclone purge`.
 * @param {Config} config
 * @param {string} bucket
 * @param {string} prefix
 */
async function deleteFolder(config, bucket, prefix) {
  let found = false;
  let token = "";
  do {
    const query = {
      "list-type": "2",
      prefix,
      "max-keys": `${Math.min(config.listChunk, 1000)}`,
    };
    if (config.urlEncode) query["encoding-type"] = "url";
    if (token) query["continuation-token"] = token;
    const response = await send(config, "GET", bucket, "", { query });
    if (response.status === 404) throw new S3Error("Not Found", 404);
    const root = parseXML(await (await check(response)).text());
    const encoded = textOf(root, "EncodingType") === "url";
    const keys = childrenOf(root, "Contents")
      .map((object) => nameOf(textOf(object, "Key"), encoded))
      .filter((key) => key !== null);
    if (keys.length) {
      found = true;
      await deleteObjects(config, bucket, keys);
    }
    token = textOf(root, "IsTruncated") === "true"
      ? textOf(root, "NextContinuationToken")
      : "";
  } while (token);

  if (prefix === "") {
    const response = await check(await send(config, "DELETE", bucket, ""));
    await response.body?.cancel();
    return;
  }
  if (!found) {
    // An empty folder with a marker.
    const head = await send(config, "HEAD", bucket, prefix);
    await head.body?.cancel();
    if (!head.ok) throw new S3Error("Not Found", 404);
    const response = await check(await send(config, "DELETE", bucket, prefix));
    await response.body?.cancel();
  }
}

/**
 * Deletes objects with one request.
 * @param {Config} config
 * @param {string} bucket
 * @param {string[]} keys At most 1000 keys.
 */
async function deleteObjects(config, bucket, keys) {
  // A key that XML cannot have, for example with a vertical tab, gets a
  // DeleteObject.
  for (const key of keys.filter((key) => !isXMLText(key))) {
    const response = await check(await send(config, "DELETE", bucket, key));
    await response.body?.cancel();
  }
  keys = keys.filter(isXMLText);
  if (keys.length === 0) return;
  const xml = new TextEncoder().encode(
    `<Delete><Quiet>true</Quiet>${
      keys.map((key) => `<Object><Key>${escapeXML(key)}</Key></Object>`)
        .join("")
    }</Delete>`,
  );
  const response = await check(
    await send(config, "POST", bucket, "", {
      query: { delete: "" },
      headers: {
        "Content-MD5": createHash("md5").update(xml).digest("base64"),
      },
      body: xml,
      length: xml.length,
      payload: sha256(xml),
    }),
  );
  const result = parseXML(await response.text());
  const error = childrenOf(result, "Error")[0];
  if (error) {
    throw new S3Error(`DeleteObjects: ${textOf(error, "Code")}`, 502);
  }
}

/** @param {Uint8Array} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Cuts a stream into parts of a size: each part has the size, but the last
 * part can be smaller.
 */
class Parts {
  /** @param {ReadableStream<Uint8Array>} stream @param {number} size */
  constructor(stream, size) {
    this.reader = stream.getReader();
    this.size = size;
    /** @type {Uint8Array} */
    this.pending = new Uint8Array(0);
    /** True when the stream has no more data. */
    this.done = false;
  }

  /**
   * The next part, or null at the end.
   * @returns {Promise<Uint8Array | null>}
   */
  async next() {
    const chunks = this.pending.length ? [this.pending] : [];
    let length = this.pending.length;
    this.pending = new Uint8Array(0);
    while (length < this.size && !this.done) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      chunks.push(value);
      length += value.length;
    }
    if (length === 0 && this.done) return null;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (length > this.size) {
      this.pending = bytes.slice(this.size);
      return bytes.subarray(0, this.size);
    }
    // A part of the size can be the last part: the next read tells it.
    if (!this.done && this.pending.length === 0) {
      const { done, value } = await this.reader.read();
      if (done) this.done = true;
      else this.pending = value;
    }
    return bytes;
  }
}

export default {
  fetch: s3,
};
