/**
 * Azure Blob Storage backend
 *
 * The azureblob backend reads and writes the blobs of the Blob service of
 * Microsoft Azure Storage, and of Azurite, its emulator, as the azureblob
 * backend of rclone.
 *
 * A path is `/container/path/to/file`. The path `/` is the list of the
 * containers, and `/container/` is the root of a container.
 *
 * The options, with the names of rclone:
 *
 * - `account` and `key`: the name of the storage account, and its key in
 *   base64, for the Shared Key authorization. With an account and no key,
 *   the requests have no authorization: a public container can answer them.
 * - `sas_url`: a URL with a shared access signature (SAS), for an account or
 *   for one container. With a SAS of a container, the remote has only that
 *   container.
 * - `connection_string`: a connection string of Azure, with
 *   `AccountName`, `AccountKey`, `BlobEndpoint`, `SharedAccessSignature`,
 *   `DefaultEndpointsProtocol` and `EndpointSuffix`.
 * - `endpoint`: the URL of the service, by default
 *   `https://ACCOUNT.blob.core.windows.net`.
 * - `use_emulator`: `true` for Azurite on `http://127.0.0.1:10000`, with the
 *   account `devstoreaccount1` and its key, for the options with no value.
 * - `chunk_size`: 4 MiB by default. A file of a known size up to this size
 *   goes in one Put Blob. A larger file, or a file of unknown size, goes in
 *   blocks of this size.
 * - `list_chunk`: 5000 by default, the number of blobs of each list.
 * - `access_tier`: `hot`, `cool`, `cold` or `archive`, for each new blob.
 * - `directory_markers`: `false` by default, thus a folder exists only when
 *   it has a file, as in rclone. With `true`, the PUT of a folder, or of a
 *   file, puts a marker for the folder and for each parent folder that has
 *   none: an empty blob with the name of the folder and a `/`, and the
 *   metadata `hdi_isfolder=true`.
 * - `no_check_container`: with `true`, a PUT does not make its container.
 * - `public_access`: `blob` or `container`, the public access of a new
 *   container.
 * - `encoding`: the names that change in the service, as rclone, by default
 *   `Slash,BackSlash,Del,Ctl,RightPeriod,InvalidUtf8`. For example, the
 *   blob of the file `a.` is `a．`, and the blob of a control character is
 *   a character of the block "Control Pictures", as `␋`. The lists give the
 *   names of the files.
 *
 * rfetch accepts `upload_concurrency`, `copy_cutoff`, `use_copy_blob`,
 * `upload_cutoff`, `disable_checksum`, `no_head_object` and
 * `delete_snapshots` of rclone, but they do nothing. The options of Azure
 * AD, for example `env_auth`, `tenant` and `use_msi`, give 501.
 *
 * Each option can also come from a header or from `env`, with the name of
 * the variable of rfetch, for example `RFETCH_AZUREBLOB_KEY`, or of rclone,
 * `RCLONE_AZUREBLOB_KEY`. Put the key in a header or in `env`, not in a URL.
 * The key, the SAS and the connection string are not in the links of a
 * list.
 *
 * As rclone, the backend keeps the time of a file in the metadata `mtime`
 * of the blob, from the header `X-OC-Mtime` of a `PUT` or a `COPY`. `GET`,
 * `HEAD` and the list give that time. A `COPY` of a file is a Copy Blob, and
 * a `PATCH` with `X-OC-Mtime` is a Set Blob Metadata. A PUT of a file makes
 * its container first, unless `no_check_container`.
 */
import { renderListing } from "@rfetch/lib/listing";
import { mimeType } from "@rfetch/lib/mime";
import { optionsOf } from "@rfetch/lib/options";
import { decodeName, encodeName, parseEncoding } from "@rfetch/lib/encoder";
import { Parts } from "@rfetch/lib/parts";
import { decodePath, encodePath } from "@rfetch/lib/path";
import {
  notSatisfiable,
  parseRange,
  partialHeaders,
  sliceStream,
} from "@rfetch/lib/range";
import { parseSize } from "@rfetch/lib/size";
import { sized } from "@rfetch/lib/sized";
import { isoStringOf, modTimeOf } from "@rfetch/lib/time";
import { childrenOf, escapeXML, parseXML, textOf } from "@rfetch/lib/xml";
import { sign } from "./sharedkey.js";

/**
 * The options of the backend, with their types, for example for the flag
 * `--azureblob-account` of the command line.
 */
export const options = {
  string: [
    "account",
    "key",
    "sas_url",
    "connection_string",
    "endpoint",
    "chunk_size",
    "list_chunk",
    "access_tier",
    "public_access",
    "upload_concurrency",
    "copy_cutoff",
    "upload_cutoff",
    "encoding",
    "delete_snapshots",
  ],
  boolean: [
    "use_emulator",
    "directory_markers",
    "no_check_container",
    "no_head_object",
    "disable_checksum",
    "use_copy_blob",
  ],
  default: {
    chunk_size: "4Mi",
    list_chunk: "5000",
    encoding: "Slash,BackSlash,Del,Ctl,RightPeriod,InvalidUtf8",
  },
};

/**
 * The options that are secret. They are not in the links of a list, which a
 * browser can keep in its history and send to other sites.
 */
const SECRETS = ["key", "sas_url", "connection_string"];

/** The options of Azure AD, which rfetch does not know. */
const AZURE_AD = [
  "env_auth",
  "tenant",
  "client_id",
  "client_secret",
  "client_certificate_path",
  "client_certificate_password",
  "username",
  "password",
  "service_principal_file",
  "use_msi",
  "msi_object_id",
  "msi_client_id",
  "msi_mi_res_id",
  "use_az",
];

/** The version of the API of the Blob service, as rclone. */
const VERSION = "2026-06-06";

/** The account of Azurite, as rclone: its name and its key are public. */
const EMULATOR = {
  account: "devstoreaccount1",
  key:
    "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
  endpoint: "http://127.0.0.1:10000/devstoreaccount1",
};

/** The name of the metadata of the time of a file, as rclone. */
const MTIME = "mtime";

/** The largest number of blocks of a blob. */
const MAX_BLOCKS = 50000;

/** The containers that this process made, by their URLs. */
const made = new Set();

/**
 * The configuration of the requests.
 * @typedef {Object} Config
 * @property {URL} endpoint The URL of the service, with no `/` at the end.
 * @property {{ account: string, key: string } | null} credentials
 * @property {URLSearchParams | null} sas The signature of a SAS.
 * @property {string} container The container of a SAS of a container, or
 *   "".
 * @property {number} chunkSize
 * @property {number} listChunk
 * @property {string} tier
 * @property {boolean} markers
 * @property {boolean} checkContainer
 * @property {string} publicAccess
 * @property {number} encoding The mask of the encoding of the names, as
 *   the option `encoding` of rclone.
 */

/** An error with the status of the answer. */
class AzureError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Serves an Azure Blob remote.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_AZUREBLOB_*` or `RCLONE_AZUREBLOB_*`.
 * @returns {Promise<Response>}
 */
async function azureblob(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);

  let config;
  try {
    config = configOf(optionsOf(request, "azureblob", env));
  } catch (error) {
    await request.body?.cancel();
    if (error instanceof AzureError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
  const path = decodePath(pathname);
  if (path === null) {
    await request.body?.cancel();
    return new Response(null, { status: 400 });
  }
  const slash = path.indexOf("/", 1);
  // The names in the service have the encoding of the option `encoding`.
  const container = encodeName(
    slash === -1 ? path.slice(1) : path.slice(1, slash),
    config.encoding,
  );
  const blob = slash === -1
    ? ""
    : encodeNames(path.slice(slash + 1), config.encoding);
  const isFolder = path.endsWith("/");
  if (!isFolder && blob === "") {
    // A file is in a container.
    await request.body?.cancel();
    return new Response(null, { status: method === "PUT" ? 400 : 404 });
  }
  const modTime = modTimeOf(request);
  if (modTime === undefined) {
    await request.body?.cancel();
    return new Response("X-OC-Mtime is not a time", { status: 400 });
  }
  /** The headers of an answer that sets the time of a file. */
  const accepted = modTime === null ? {} : { "X-OC-Mtime": "accepted" };

  try {
    if (method === "GET" || method === "HEAD") {
      if (!isFolder) return await getFile(config, container, blob, request);
      const query = new URLSearchParams(searchParams);
      for (const name of SECRETS) query.delete(name);
      return await getFolder(config, container, blob, method, `${query}`);
    }
    if (container === "") {
      await request.body?.cancel();
      return new Response(null, { status: 405, headers: { Allow: "GET" } });
    }
    if (method === "PUT") {
      if (isFolder) {
        await request.body?.cancel();
        await putFolder(config, container, blob);
      } else {
        await putFile(config, container, blob, request, modTime);
      }
      return new Response(null, {
        status: 201,
        headers: {
          "Content-Location": pathname,
          ...(isFolder ? {} : accepted),
        },
      });
    }
    if (method === "DELETE") {
      await (isFolder
        ? deleteFolder(config, container, blob)
        : deleteFile(config, container, blob));
      return new Response(null, { status: 204 });
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
      await copyFile(config, { container, blob }, {
        container: encodeName(target.slice(1, end), config.encoding),
        blob: encodeNames(target.slice(end + 1), config.encoding),
      }, modTime);
      return new Response(null, { status: 201, headers: accepted });
    }
    if (method === "PATCH" && !isFolder) {
      if (modTime === null) {
        return new Response("X-OC-Mtime is missing", { status: 400 });
      }
      await setModTime(config, container, blob, modTime);
      return new Response(null, { status: 204, headers: accepted });
    }
  } catch (error) {
    await request.body?.cancel().catch(() => {});
    if (error instanceof AzureError) {
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
 * Encodes each name of a path, as `FromStandardPath` of rclone.
 * @param {string} path For example `a/b.txt`, or `a/` for a folder.
 * @param {number} mask
 */
function encodeNames(path, mask) {
  return path.split("/").map((name) => encodeName(name, mask)).join("/");
}

/**
 * Reads the options of a request, as `NewFs` of the azureblob backend of
 * rclone.
 * @param {URLSearchParams | Map<string, string>} values
 * @returns {Config}
 * @throws {AzureError} When an option is not correct.
 */
function configOf(values) {
  /** @param {string} name */
  const get = (name) => values.get(name) ?? options.default[name] ?? "";
  for (const name of AZURE_AD) {
    const value = get(name);
    if (value && value !== "false") {
      throw new AzureError(`rfetch does not know the option ${name}`, 501);
    }
  }
  let account = get("account");
  let key = get("key");
  let endpoint = get("endpoint");
  /** @type {URLSearchParams | null} */
  let sas = null;
  let container = "";

  if (get("use_emulator") === "true") {
    account ||= EMULATOR.account;
    key ||= EMULATOR.key;
    endpoint ||= EMULATOR.endpoint;
  }
  const connection = get("connection_string");
  if (connection) {
    /** @type {Record<string, string>} */
    const parts = {};
    for (const part of connection.split(";")) {
      const equal = part.indexOf("=");
      if (equal > 0) parts[part.slice(0, equal).trim()] = part.slice(equal + 1);
    }
    account ||= parts.AccountName ?? "";
    key ||= parts.AccountKey ?? "";
    endpoint ||= parts.BlobEndpoint ??
      (account
        ? `${parts.DefaultEndpointsProtocol || "https"}://${account}.blob.${
          parts.EndpointSuffix || "core.windows.net"
        }`
        : "");
    if (parts.SharedAccessSignature) {
      sas = new URLSearchParams(parts.SharedAccessSignature);
    }
  }
  const sasURL = get("sas_url");
  if (sasURL) {
    let url;
    try {
      url = new URL(sasURL);
    } catch {
      throw new AzureError("The sas_url option is not a URL", 400);
    }
    const names = url.pathname.split("/").filter(Boolean);
    // A URL of the emulator, or of an IP address, has the account in its
    // path.
    const pathStyle = /^[\d.]+$|^\[|^localhost$/.test(url.hostname);
    const prefix = pathStyle ? names.slice(0, 1) : [];
    container = decodeURIComponent(names[prefix.length] ?? "");
    endpoint = `${url.origin}${prefix.map((name) => `/${name}`).join("")}`;
    sas = url.searchParams;
  }
  if (!endpoint) {
    if (!account) {
      throw new AzureError("The account option or a SAS is missing", 400);
    }
    endpoint = `https://${account}.blob.core.windows.net`;
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AzureError("The endpoint is not a URL", 400);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";

  const chunkSize = parseSize(get("chunk_size"));
  if (!(chunkSize >= 1)) {
    throw new AzureError("chunk_size must be at least 1 byte", 400);
  }
  const listChunk = Number(get("list_chunk"));
  if (!Number.isInteger(listChunk) || listChunk < 1 || listChunk > 5000) {
    throw new AzureError("list_chunk must be from 1 to 5000", 400);
  }
  const tier = get("access_tier");
  if (tier && !/^(hot|cool|cold|archive)$/i.test(tier)) {
    throw new AzureError(`azure: tier ${tier} not recognized`, 400);
  }
  let encoding;
  try {
    encoding = parseEncoding(get("encoding"));
  } catch (error) {
    throw new AzureError(error.message, 400);
  }
  const publicAccess = get("public_access");
  if (publicAccess && !/^(blob|container)$/.test(publicAccess)) {
    throw new AzureError(
      `public_access must be blob or container, not ${publicAccess}`,
      400,
    );
  }
  return {
    endpoint: url,
    credentials: key && !sas ? { account, key } : null,
    sas,
    container,
    chunkSize,
    listChunk,
    tier,
    markers: get("directory_markers") === "true",
    checkContainer: get("no_check_container") !== "true" && !container,
    publicAccess,
    encoding,
  };
}

/**
 * The URL of a container or of a blob.
 * @param {Config} config
 * @param {string} container "" for the service.
 * @param {string} blob "" for the container.
 * @param {Record<string, string>} [query]
 * @returns {URL}
 */
function urlOf(config, container, blob, query = {}) {
  const url = new URL(config.endpoint);
  let path = url.pathname;
  if (container) path += `/${encodeURIComponent(container)}`;
  if (blob) path += `/${encodePath(blob)}`;
  url.pathname = path || "/";
  const params = Object.entries(query);
  if (config.sas) params.push(...config.sas);
  url.search = params
    .map(([name, value]) =>
      `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
    )
    .join("&");
  return url;
}

/**
 * Sends a request to the Blob service, with the authorization of the
 * configuration.
 * @param {Config} config
 * @param {string} method
 * @param {string} container "" for the service.
 * @param {string} blob "" for the container.
 * @param {Object} [init]
 * @param {Record<string, string>} [init.query]
 * @param {Record<string, string>} [init.headers]
 * @param {BodyInit | null} [init.body]
 * @returns {Promise<Response>}
 * @throws {AzureError} When the service does not answer, or when the
 *   container is not the container of the SAS.
 */
async function send(
  config,
  method,
  container,
  blob,
  { query = {}, headers = {}, body = null } = {},
) {
  if (config.container && container && container !== config.container) {
    throw new AzureError(
      `The SAS is only for the container ${config.container}`,
      403,
    );
  }
  const url = urlOf(config, container, blob, query);
  let all = new Headers(headers);
  all.set("x-ms-version", VERSION);
  // The size of a file is the size of its body.
  all.set("Accept-Encoding", "identity");
  if (config.credentials) {
    all = sign({ method, url, headers: all }, config.credentials);
  }
  /** @type {RequestInit} */
  const init = { method, headers: all };
  if (body !== null) {
    init.body = body;
    if (body instanceof ReadableStream) init.duplex = "half";
  }
  try {
    return await fetch(url, init);
  } catch {
    throw new AzureError("The Blob service did not answer", 502);
  }
}

/**
 * Makes sure that an answer is a success, else throws its error, with the
 * code of the service.
 * @param {Response} response
 * @returns {Promise<Response>}
 * @throws {AzureError}
 */
async function check(response) {
  if (response.ok) return response;
  const text = await response.text().catch(() => "");
  let code = response.headers.get("x-ms-error-code") ?? "";
  if (!code) {
    try {
      code = textOf(parseXML(text), "Code");
    } catch {
      // An answer with no XML, for example of HEAD.
    }
  }
  throw new AzureError(code || response.statusText, response.status);
}

/**
 * The metadata of a blob, from the headers `x-ms-meta-*`, by their names in
 * lower case.
 * @param {Headers} headers
 * @returns {Record<string, string>}
 */
function metadataOf(headers) {
  /** @type {Record<string, string>} */
  const metadata = {};
  for (const [name, value] of headers) {
    if (name.startsWith("x-ms-meta-")) metadata[name.slice(10)] = value;
  }
  return metadata;
}

/**
 * The headers `x-ms-meta-*` of metadata.
 * @param {Record<string, string>} metadata
 * @returns {Record<string, string>}
 */
function metaHeaders(metadata) {
  return Object.fromEntries(
    Object.entries(metadata).map((
      [name, value],
    ) => [`x-ms-meta-${name}`, value]),
  );
}

/**
 * Tells if a blob is the marker of a folder, as rclone: an empty blob with a
 * name that ends with `/`, or with the metadata `hdi_isfolder=true`.
 * @param {string} name
 * @param {number} size
 * @param {Record<string, string>} metadata
 */
function isMarker(name, size, metadata) {
  return size === 0 &&
    (name === "" || name.endsWith("/") || metadata.hdi_isfolder === "true");
}

/**
 * The time of a blob in ISO 8601: its metadata `mtime`, else its
 * `Last-Modified`, as rclone.
 * @param {Record<string, string>} metadata
 * @param {string | null} lastModified
 * @returns {string}
 */
function timeOf(metadata, lastModified) {
  const mtime = metadata[MTIME];
  if (mtime !== undefined) {
    return Number.isNaN(Date.parse(mtime)) ? "0001-01-01T00:00:00Z" : mtime;
  }
  const time = Date.parse(lastModified ?? "");
  return Number.isNaN(time)
    ? ""
    : new Date(time).toISOString().replace(/\.000Z$/, "Z");
}

/**
 * Gets a file, or only its headers for HEAD, with the range of the request.
 *
 * A range `bytes=START-END` or `bytes=START-` goes to the service, and the
 * client gets its answer 206 when it starts at START. Else, and for a range
 * of the last bytes, which the Blob service does not read, the backend gets
 * the size with HEAD first, and makes the answer of RFC 9110.
 * @param {Config} config
 * @param {string} container
 * @param {string} blob
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function getFile(config, container, blob, request) {
  const { method } = request;
  const header = method === "GET" ? request.headers.get("Range") : null;
  let range = null;
  try {
    // Only the form of the range: the size is not known yet.
    range = parseRange(header, Number.MAX_SAFE_INTEGER);
  } catch {
    // For example bytes=-0: no byte of a file is in the range.
    return await getRange(config, container, blob, header);
  }
  if (range && /^bytes=\d/.test(header ?? "")) {
    const response = await send(config, "GET", container, blob, {
      headers: { Range: header },
    });
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      response.headers.get("Content-Range") ?? "",
    );
    // Azurite gives 206 for a start at the end of the file, for example
    // `bytes 10-9/10`: then the range has no byte of the file.
    if (
      response.status === 206 && match &&
      Number(match[1]) === range.start &&
      Number(match[1]) <= Number(match[2]) &&
      Number(match[2]) < Number(match[3])
    ) {
      return fileResponse(response, blob);
    }
    await response.body?.cancel();
    if (response.ok || response.status === 416) {
      return await getRange(config, container, blob, header);
    }
    return new Response(null, { status: response.status });
  }
  if (range) return await getRange(config, container, blob, header);
  const response = await send(config, method, container, blob);
  if (!response.ok) {
    await response.body?.cancel();
    return new Response(null, { status: response.status });
  }
  return fileResponse(response, blob, method === "HEAD");
}

/**
 * Gets a range of a file with the size of a HEAD request, as RFC 9110.
 * @param {Config} config
 * @param {string} container
 * @param {string} blob
 * @param {string | null} header The `Range` of the request.
 * @returns {Promise<Response>}
 */
async function getRange(config, container, blob, header) {
  const head = await send(config, "HEAD", container, blob);
  await head.body?.cancel();
  if (!head.ok) return new Response(null, { status: head.status });
  if (
    isMarker(
      blob,
      Number(head.headers.get("Content-Length")),
      metadataOf(head.headers),
    )
  ) {
    return new Response(null, { status: 404 });
  }
  const size = Number(head.headers.get("Content-Length"));
  let range;
  try {
    range = parseRange(header, size);
  } catch {
    return notSatisfiable(size);
  }
  const response = await send(config, "GET", container, blob, {
    headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {},
  });
  if (!response.ok) {
    await response.body?.cancel();
    return new Response(null, { status: response.status });
  }
  if (!range) return fileResponse(response, blob);
  const length = range.end - range.start + 1;
  let body = response.body;
  // A service that sends all the file sends the bytes before the range too.
  if (response.status !== 206) body = sliceStream(body, range.start, length);
  const headers = fileHeaders(response.headers, blob);
  for (const [name, value] of Object.entries(partialHeaders(range, size))) {
    headers.set(name, value);
  }
  return new Response(sized(body, length), { status: 206, headers });
}

/**
 * The answer for a blob, with the headers of the answer of the service. A
 * marker is a folder, thus not a file.
 * @param {Response} response
 * @param {string} blob
 * @param {boolean} [head] True for no body.
 * @returns {Response}
 */
function fileResponse(response, blob, head = false) {
  const length = response.headers.get("Content-Length");
  if (
    !response.headers.has("Content-Range") &&
    isMarker(blob, Number(length), metadataOf(response.headers))
  ) {
    response.body?.cancel();
    return new Response(null, { status: 404 });
  }
  const headers = fileHeaders(response.headers, blob);
  if (length !== null) headers.set("Content-Length", length);
  const contentRange = response.headers.get("Content-Range");
  if (contentRange) headers.set("Content-Range", contentRange);
  if (head) {
    response.body?.cancel();
    return new Response(null, { headers });
  }
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The headers of a file for its answer, from the headers of the service:
 * its type and its time.
 * @param {Headers} service
 * @param {string} blob
 * @returns {Headers}
 */
function fileHeaders(service, blob) {
  const headers = new Headers({
    "Content-Type": service.get("Content-Type") || mimeType(blob),
    "Accept-Ranges": "bytes",
  });
  const time = Date.parse(
    timeOf(metadataOf(service), service.get("Last-Modified")),
  );
  if (!Number.isNaN(time)) {
    headers.set("Last-Modified", new Date(time).toUTCString());
  }
  return headers;
}

/**
 * Gets the list of a folder, or only its headers for HEAD.
 * @param {Config} config
 * @param {string} container "" for the list of the containers.
 * @param {string} prefix The path of the folder in the container, with a
 *   `/` at the end, or "" for the root of the container.
 * @param {string} method
 * @param {string} query The query of each link.
 * @returns {Promise<Response>}
 */
async function getFolder(config, container, prefix, method, query) {
  const entries = container === ""
    ? await listContainers(config)
    : await listFolder(config, container, prefix);
  if (entries === null) return new Response(null, { status: 404 });
  const headers = { "Content-Type": "text/html;charset=utf-8" };
  if (method === "HEAD") return new Response(null, { headers });
  return new Response(renderListing(entries, { query }), { headers });
}

/**
 * The containers, as folders. With a SAS of a container, only that
 * container.
 * @param {Config} config
 * @returns {Promise<import("@rfetch/lib/listing").Entry[]>}
 */
async function listContainers(config) {
  if (config.container) {
    return [{
      Name: decodeName(config.container, config.encoding),
      IsDir: true,
      Size: -1,
      MimeType: "",
      ModTime: "",
    }];
  }
  /** @type {import("@rfetch/lib/listing").Entry[]} */
  const entries = [];
  let marker = "";
  do {
    /** @type {Record<string, string>} */
    const query = { comp: "list", maxresults: `${config.listChunk}` };
    if (marker) query.marker = marker;
    const response = await check(await send(config, "GET", "", "", { query }));
    const root = parseXML(await response.text());
    for (
      const item of childrenOf(childrenOf(root, "Containers")[0], "Container")
    ) {
      const properties = childrenOf(item, "Properties")[0];
      entries.push({
        Name: decodeName(textOf(item, "Name"), config.encoding),
        IsDir: true,
        Size: -1,
        MimeType: "",
        ModTime: timeOf({}, textOf(properties, "Last-Modified")),
      });
    }
    marker = textOf(root, "NextMarker");
  } while (marker);
  return entries;
}

/**
 * The name of a blob of a list: with `Encoded="true"`, the name has the
 * percent-encoding of a query, as `url.QueryUnescape` of Go.
 * @param {import("@rfetch/lib/xml").XMLElement} element
 * @returns {string | null} null for an encoding that is not correct.
 */
function nameOf(element) {
  const [name] = childrenOf(element, "Name");
  if (!name) return null;
  if (name.attributes?.Encoded !== "true") return name.text;
  try {
    return decodeURIComponent(name.text.replaceAll("+", " "));
  } catch {
    return null;
  }
}

/**
 * Reads the metadata of a blob of a list, by their names in lower case.
 * @param {import("@rfetch/lib/xml").XMLElement} element
 * @returns {Record<string, string>}
 */
function listMetadata(element) {
  /** @type {Record<string, string>} */
  const metadata = {};
  for (const item of childrenOf(element, "Metadata")[0]?.children ?? []) {
    metadata[item.name.toLowerCase()] = item.text;
  }
  return metadata;
}

/**
 * The files and the folders in a folder, as `list` of the azureblob backend
 * of rclone with a delimiter.
 * @param {Config} config
 * @param {string} container
 * @param {string} prefix "" for the root of the container.
 * @returns {Promise<import("@rfetch/lib/listing").Entry[] | null>} null when
 *   the folder does not exist.
 */
async function listFolder(config, container, prefix) {
  /** @type {import("@rfetch/lib/listing").Entry[]} */
  const entries = [];
  const folders = new Set();
  let found = false;
  let marker = "";
  do {
    /** @type {Record<string, string>} */
    const query = {
      restype: "container",
      comp: "list",
      delimiter: "/",
      include: "metadata",
      maxresults: `${config.listChunk}`,
      prefix,
    };
    if (marker) query.marker = marker;
    const response = await send(config, "GET", container, "", { query });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    const root = parseXML(await (await check(response)).text());
    const blobs = childrenOf(root, "Blobs")[0];
    for (const item of childrenOf(blobs, "BlobPrefix")) {
      const name = nameOf(item);
      if (name === null || !name.startsWith(prefix)) continue;
      found = true;
      const folder = name.slice(prefix.length).replace(/\/$/, "");
      if (folder === "" || folder.includes("/")) continue;
      folders.add(folder);
    }
    for (const item of childrenOf(blobs, "Blob")) {
      const name = nameOf(item);
      if (name === null || !name.startsWith(prefix)) continue;
      found = true;
      const file = name.slice(prefix.length);
      // The marker of the folder is not a file in it.
      if (file === "") continue;
      const properties = childrenOf(item, "Properties")[0];
      const size = Number(textOf(properties, "Content-Length"));
      const metadata = listMetadata(item);
      if (isMarker(file, size, metadata)) {
        const folder = file.replace(/\/$/, "");
        if (folder && !folder.includes("/")) folders.add(folder);
        continue;
      }
      if (file.includes("/")) continue;
      const Name = decodeName(file, config.encoding);
      entries.push({
        Name,
        IsDir: false,
        Size: size,
        MimeType: textOf(properties, "Content-Type") || mimeType(Name),
        ModTime: timeOf(metadata, textOf(properties, "Last-Modified")),
      });
    }
    marker = textOf(root, "NextMarker");
  } while (marker);

  // The root of a container exists with no file. An empty folder exists
  // when it has a marker, as rclone checks it.
  if (!found && prefix !== "") {
    if (!config.markers) return null;
    const response = await send(config, "HEAD", container, prefix);
    await response.body?.cancel();
    if (!response.ok) return null;
  }
  for (const folder of folders) {
    entries.push({
      Name: decodeName(folder, config.encoding),
      IsDir: true,
      Size: -1,
      MimeType: "",
      ModTime: "",
    });
  }
  return entries;
}

/**
 * Makes a container, as rclone: a container that exists is not an error.
 * @param {Config} config
 * @param {string} container
 */
async function makeContainer(config, container) {
  const key = urlOf(config, container, "").href;
  if (made.has(key)) return;
  /** @type {Record<string, string>} */
  const headers = {};
  if (config.publicAccess) {
    headers["x-ms-blob-public-access"] = config.publicAccess;
  }
  const response = await send(config, "PUT", container, "", {
    query: { restype: "container" },
    headers,
  });
  if (response.status !== 409) await check(response);
  await response.body?.cancel();
  made.add(key);
}

/**
 * Makes a container, or a marker of a folder with the option
 * `directory_markers`. With no marker, a folder exists when it has a file.
 * @param {Config} config
 * @param {string} container
 * @param {string} prefix
 */
async function putFolder(config, container, prefix) {
  if (config.checkContainer || prefix === "") {
    await makeContainer(config, container);
  }
  if (prefix !== "" && config.markers) {
    await putMarkers(config, container, prefix);
  }
}

/**
 * Puts the markers of a folder and of its parent folders, as rclone: from
 * the folder to the root of the container, until a marker exists.
 * @param {Config} config
 * @param {string} container
 * @param {string} prefix The folder, with a `/` at the end.
 */
async function putMarkers(config, container, prefix) {
  while (prefix !== "") {
    const head = await send(config, "HEAD", container, prefix);
    await head.body?.cancel();
    if (head.ok) return;
    const response = await send(config, "PUT", container, prefix, {
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "Content-Length": "0",
        "x-ms-blob-content-type": "application/octet-stream",
        "x-ms-meta-hdi_isfolder": "true",
        [`x-ms-meta-${MTIME}`]: isoStringOf(BigInt(Date.now()) * 1000000n),
      },
      body: new Uint8Array(0),
    });
    await check(response);
    await response.body?.cancel();
    prefix = prefix.slice(0, prefix.lastIndexOf("/", prefix.length - 2) + 1);
  }
}

/**
 * Puts a file: in one Put Blob up to `chunk_size`, else in blocks, as
 * rclone. The container, and the markers with `directory_markers`, come
 * first.
 * @param {Config} config
 * @param {string} container
 * @param {string} blob
 * @param {Request} request
 * @param {bigint | null} modTime The time of the file, in the metadata
 *   `mtime`, or null.
 */
async function putFile(config, container, blob, request, modTime) {
  if (config.checkContainer) await makeContainer(config, container);
  if (config.markers) {
    await putMarkers(
      config,
      container,
      blob.slice(0, blob.lastIndexOf("/") + 1),
    );
  }
  const header = request.headers.get("Content-Length");
  const length = header !== null && /^\d+$/.test(header)
    ? Number(header)
    : null;
  /** @type {Record<string, string>} */
  const headers = {
    "x-ms-blob-content-type": request.headers.get("Content-Type") ||
      mimeType(blob),
  };
  if (modTime !== null) headers[`x-ms-meta-${MTIME}`] = isoStringOf(modTime);
  if (config.tier) headers["x-ms-access-tier"] = config.tier;

  const body = request.body ?? new Blob([]).stream();
  if (length !== null && length <= config.chunkSize) {
    const response = await send(config, "PUT", container, blob, {
      headers: {
        ...headers,
        "x-ms-blob-type": "BlockBlob",
        "Content-Length": `${length}`,
      },
      body: sized(body, length),
    });
    await check(response);
    await response.body?.cancel();
    return;
  }

  // A block has the size of chunk_size, or more for a large file, in MiB.
  let blockSize = config.chunkSize;
  if (length !== null && length / blockSize > MAX_BLOCKS) {
    const mebibyte = 1024 * 1024;
    blockSize = Math.ceil(length / MAX_BLOCKS / mebibyte) * mebibyte;
  }
  const parts = new Parts(body, blockSize);
  const random = crypto.getRandomValues(new Uint8Array(8));
  /** @type {string[]} */
  const ids = [];
  for (let part = await parts.next(); part; part = await parts.next()) {
    if (ids.length === MAX_BLOCKS) throw new AzureError("too many blocks", 413);
    const id = blockId(ids.length, random);
    const response = await send(config, "PUT", container, blob, {
      query: { comp: "block", blockid: id },
      headers: { "Content-Length": `${part.length}` },
      body: part,
    });
    await check(response);
    await response.body?.cancel();
    ids.push(id);
    if (parts.done) break;
  }
  const xml = new TextEncoder().encode(
    `<?xml version="1.0" encoding="utf-8"?><BlockList>${
      ids.map((id) => `<Latest>${escapeXML(id)}</Latest>`).join("")
    }</BlockList>`,
  );
  const response = await send(config, "PUT", container, blob, {
    query: { comp: "blocklist" },
    headers: { ...headers, "Content-Length": `${xml.length}` },
    body: xml,
  });
  await check(response);
  await response.body?.cancel();
}

/**
 * The ID of a block, as rclone: the number of the block in 8 bytes, big
 * endian, then 8 random bytes of the upload, in base64.
 * @param {number | bigint} index
 * @param {Uint8Array} random
 * @returns {string}
 */
export function blockId(index, random) {
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(index));
  bytes.set(random, 8);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Copies a blob with Copy Blob, as `Copy` of rclone. With a time, the copy
 * gets the metadata of the source, with that time. With no time, the copy
 * keeps the metadata of the source. The backend waits for the end of the
 * copy.
 * @param {Config} config
 * @param {{ container: string, blob: string }} source
 * @param {{ container: string, blob: string }} target
 * @param {bigint | null} modTime
 * @throws {AzureError} With 404 for a source that does not exist.
 */
async function copyFile(config, source, target, modTime) {
  const head = await send(config, "HEAD", source.container, source.blob);
  await head.body?.cancel();
  if (head.status === 404) throw new AzureError("BlobNotFound", 404);
  await check(head);
  const metadata = metadataOf(head.headers);
  if (
    isMarker(source.blob, Number(head.headers.get("Content-Length")), metadata)
  ) {
    throw new AzureError("BlobNotFound", 404);
  }
  if (config.checkContainer) await makeContainer(config, target.container);
  if (config.markers) {
    await putMarkers(
      config,
      target.container,
      target.blob.slice(0, target.blob.lastIndexOf("/") + 1),
    );
  }
  /** @type {Record<string, string>} */
  const headers = {
    "x-ms-copy-source": urlOf(config, source.container, source.blob).href,
  };
  if (modTime !== null) {
    Object.assign(
      headers,
      metaHeaders({ ...metadata, [MTIME]: isoStringOf(modTime) }),
    );
  }
  if (config.tier) headers["x-ms-access-tier"] = config.tier;
  const response = await send(config, "PUT", target.container, target.blob, {
    headers,
  });
  await check(response);
  await response.body?.cancel();
  // A copy can end later: the backend waits for it.
  let status = response.headers.get("x-ms-copy-status");
  for (let wait = 100; status === "pending"; wait = Math.min(wait * 2, 1000)) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    const state = await send(config, "HEAD", target.container, target.blob);
    await state.body?.cancel();
    await check(state);
    status = state.headers.get("x-ms-copy-status");
  }
  if (status && status !== "success") {
    throw new AzureError(`The copy of the blob ended with ${status}`, 502);
  }
}

/**
 * Sets the time of a blob with Set Blob Metadata, as `SetModTime` of
 * rclone: the call takes the place of all the metadata.
 * @param {Config} config
 * @param {string} container
 * @param {string} blob
 * @param {bigint} modTime
 */
async function setModTime(config, container, blob, modTime) {
  const head = await send(config, "HEAD", container, blob);
  await head.body?.cancel();
  if (head.status === 404) throw new AzureError("BlobNotFound", 404);
  await check(head);
  const metadata = metadataOf(head.headers);
  if (isMarker(blob, Number(head.headers.get("Content-Length")), metadata)) {
    throw new AzureError("BlobNotFound", 404);
  }
  const response = await send(config, "PUT", container, blob, {
    query: { comp: "metadata" },
    headers: metaHeaders({ ...metadata, [MTIME]: isoStringOf(modTime) }),
  });
  await check(response);
  await response.body?.cancel();
}

/**
 * Deletes a blob. A marker is not a file.
 * @param {Config} config
 * @param {string} container
 * @param {string} blob
 */
async function deleteFile(config, container, blob) {
  const response = await send(config, "DELETE", container, blob);
  if (response.status === 404) {
    await response.body?.cancel();
    throw new AzureError("BlobNotFound", 404);
  }
  await check(response);
  await response.body?.cancel();
}

/**
 * Deletes a folder and all that is in it, with lists with no delimiter. The
 * root of a container deletes the container, as `rclone purge`.
 * @param {Config} config
 * @param {string} container
 * @param {string} prefix
 */
async function deleteFolder(config, container, prefix) {
  if (prefix === "") {
    const response = await send(config, "DELETE", container, "", {
      query: { restype: "container" },
    });
    if (response.status === 404) {
      await response.body?.cancel();
      throw new AzureError("ContainerNotFound", 404);
    }
    await check(response);
    await response.body?.cancel();
    made.delete(urlOf(config, container, "").href);
    return;
  }
  let found = false;
  let marker = "";
  do {
    /** @type {Record<string, string>} */
    const query = {
      restype: "container",
      comp: "list",
      maxresults: `${config.listChunk}`,
      prefix,
    };
    if (marker) query.marker = marker;
    const response = await send(config, "GET", container, "", { query });
    if (response.status === 404) {
      await response.body?.cancel();
      throw new AzureError("ContainerNotFound", 404);
    }
    const root = parseXML(await (await check(response)).text());
    const names = childrenOf(childrenOf(root, "Blobs")[0], "Blob")
      .map(nameOf)
      .filter((name) => name !== null && name.startsWith(prefix));
    if (names.length) found = true;
    // Eight deletes at the same time.
    for (let i = 0; i < names.length; i += 8) {
      await Promise.all(
        names.slice(i, i + 8).map(async (name) => {
          const deleted = await send(config, "DELETE", container, name);
          if (deleted.status !== 404) await check(deleted);
          await deleted.body?.cancel();
        }),
      );
    }
    marker = textOf(root, "NextMarker");
  } while (marker);
  if (!found) throw new AzureError("directory not found", 404);
}

export default {
  fetch: azureblob,
};
