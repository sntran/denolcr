/**
 * DOI backend
 *
 * The doi backend reads the files of a dataset with a DOI (Digital Object
 * Identifier), as the doi backend of rclone: a dataset of Zenodo, of
 * another InvenioRDM server, or of Dataverse. It only reads.
 *
 * The options, as rclone:
 *
 * - `doi`: the DOI, or its URL, for example `10.5281/zenodo.2600782`,
 *   `doi:10.5281/zenodo.2600782` or `https://doi.org/10.5281/zenodo.2600782`.
 * - `provider`: `zenodo`, `invenio` or `dataverse`. With another value, or
 *   with no value, the backend finds the provider from the URL of the DOI.
 * - `doi_resolver_api_url`: the API of the resolver of the DOI,
 *   `https://doi.org/api` by default.
 *
 * The backend asks the resolver for the URL of the DOI, then the API of the
 * provider for the list of the files of the dataset:
 *
 * - Zenodo: the URL `/api/records/ID` of the server of the DOI, with the ID
 *   after `zenodo.` in the DOI.
 * - InvenioRDM: the link `linkset` in the header `Link` of the page of the
 *   DOI, else `/api/records/ID` for a page `/records/ID`.
 * - Dataverse: the server `dataverse.harvard.edu`, or a URL with the query
 *   `persistentId`. All the files have the time of the last change of the
 *   dataset.
 *
 * A name with `/` is in folders. A file has the time of the provider, to the
 * second. The list stays in memory for 5 minutes after its last use, as in
 * rclone. A `Range` of a file goes to the server of the file.
 */
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
import { sized } from "@rfetch/lib/sized";

/**
 * The options of the backend, with their types, for example for the flag
 * `--doi-provider` of the command line.
 */
export const options = {
  string: ["doi", "provider", "doi_resolver_api_url"],
};

/** The API of the resolver of a DOI, by default. */
const RESOLVER = "https://doi.org/api";

/** The time of a file with no time that is correct, as rclone. */
const EPOCH = "1970-01-01T00:00:00Z";

/** The milliseconds that a list stays in memory after its last use. */
const CACHE_TIME = 5 * 60 * 1000;

/** The methods that change files. */
const WRITES = ["PUT", "DELETE", "COPY", "MOVE", "PATCH"];

/**
 * A file of a dataset.
 * @typedef {Object} DataFile
 * @property {string} path The path in the dataset, for example `a/b.txt`.
 * @property {number} size
 * @property {string} type The media type, or "".
 * @property {string} modTime The time in ISO 8601, to the second.
 * @property {string} url The URL of the bytes of the file.
 */

/**
 * The lists of the datasets, by the options, with the time of their end.
 * @type {Map<string, { files: Promise<DataFile[]>, expires: number }>}
 */
const cache = new Map();

/** An error with the status of the answer to the client. */
class DOIError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * Serves the files of a dataset with a DOI.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_DOI_*` or `RCLONE_DOI_*`.
 * @returns {Promise<Response>}
 */
async function doi(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);
  if (WRITES.includes(method)) {
    await request.body?.cancel();
    return new Response("doi remotes are read only", { status: 403 });
  }
  if (method !== "GET" && method !== "HEAD") {
    await request.body?.cancel();
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const path = decodePath(pathname);
  if (path === null) return new Response(null, { status: 400 });

  const values = optionsOf(request, "doi", env);
  const name = parseDoi(values.get("doi") ?? "");
  if (!name) return new Response("Missing doi", { status: 400 });
  const provider = values.get("provider") ?? "";
  const resolver = values.get("doi_resolver_api_url") || RESOLVER;

  let files;
  try {
    files = await filesOf(name, provider, resolver);
  } catch (error) {
    if (error instanceof DOIError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }

  if (path.endsWith("/")) {
    const entries = list(files, path.slice(1));
    if (entries === null) return new Response(null, { status: 404 });
    const headers = { "Content-Type": "text/html;charset=utf-8" };
    if (method === "HEAD") return new Response(null, { headers });
    return new Response(
      renderListing(entries, { query: `${searchParams}` }),
      { headers },
    );
  }
  const file = files.find((file) => file.path === path.slice(1));
  if (!file) return new Response(null, { status: 404 });
  return await getFile(file, request);
}

/**
 * Reads a DOI as rclone: the text after `doi:`, or the path of a URL of
 * `doi.org`. Another text is the DOI.
 * @param {string} text
 * @returns {string}
 */
export function parseDoi(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  if (url.protocol === "doi:") {
    return (text.startsWith("doi:") ? text.slice(4) : text).replace(/^\/+/, "");
  }
  if (url.hostname.endsWith("doi.org")) {
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // The path stays with its percent-encoding.
    }
    return path.replace(/^\/+/, "");
  }
  return text;
}

/**
 * Gives the files of a dataset, from the cache or from the provider.
 * @param {string} name The DOI.
 * @param {string} provider
 * @param {string} resolver
 * @returns {Promise<DataFile[]>}
 */
async function filesOf(name, provider, resolver) {
  const key = JSON.stringify([name, provider, resolver]);
  const now = Date.now();
  for (const [other, { expires }] of cache) {
    if (expires < now) cache.delete(other);
  }
  let entry = cache.get(key);
  if (!entry) {
    const files = readDataset(name, provider, resolver);
    entry = { files, expires: 0 };
    cache.set(key, entry);
    // An error is not in the cache.
    files.catch(() => cache.delete(key));
  }
  entry.expires = now + CACHE_TIME;
  return await entry.files;
}

/**
 * Finds the provider of a dataset, and reads the list of its files.
 * @param {string} name The DOI.
 * @param {string} provider
 * @param {string} resolver
 * @returns {Promise<DataFile[]>}
 */
async function readDataset(name, provider, resolver) {
  const landing = await resolve(name, resolver);
  const forced = ["dataverse", "invenio", "zenodo"].includes(provider)
    ? provider
    : "";
  if (
    forced === "dataverse" || (!forced && (
      landing.hostname.toLowerCase() === "dataverse.harvard.edu" ||
      landing.searchParams.get("persistentId")
    ))
  ) {
    return await dataverseFiles(landing);
  }
  if (
    forced === "zenodo" || (!forced && (
      landing.hostname === "zenodo.org" ||
      landing.hostname.endsWith(".zenodo.org")
    ))
  ) {
    return await invenioFiles(await zenodoEndpoint(name, landing));
  }
  const endpoint = await invenioEndpoint(landing).catch((error) => {
    if (forced) throw error;
    return null;
  });
  if (!endpoint) {
    throw new DOIError(`provider '${landing.hostname}' is not supported`, 501);
  }
  return await invenioFiles(endpoint);
}

/**
 * Sends a GET request, and reads its JSON.
 * @param {string | URL} url
 * @returns {Promise<any>}
 * @throws {DOIError} When the server gives an error, or no JSON.
 */
async function getJSON(url) {
  const response = await send(url);
  try {
    return await response.json();
  } catch {
    throw new DOIError(`could not parse API response from '${url}'`);
  }
}

/**
 * Sends a GET request, with no header of the client.
 * @param {string | URL} url
 * @returns {Promise<Response>} An answer 2xx.
 * @throws {DOIError} When the server does not answer, or gives an error.
 */
async function send(url) {
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new DOIError(`The server of ${new URL(url).host} did not answer`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new DOIError(
      `HTTP error ${response.status} (${response.statusText}) returned body: ` +
        JSON.stringify(text.slice(0, 200)),
      response.status === 404 ? 404 : 502,
    );
  }
  return response;
}

/**
 * Gives the URL of a DOI, from the API of the resolver: the last value of
 * the type `URL`, as rclone.
 * @param {string} name The DOI.
 * @param {string} resolver
 * @returns {Promise<URL>}
 */
async function resolve(name, resolver) {
  const answer = await getJSON(
    `${resolver.replace(/\/$/, "")}/handles/${name}?index=1`,
  );
  if (answer?.responseCode !== 1) {
    // The code 100 is a DOI that does not exist.
    throw new DOIError(
      `could not resolve DOI (error code ${answer?.responseCode})`,
      answer?.responseCode === 100 ? 404 : 502,
    );
  }
  let value;
  for (const item of answer.values ?? []) {
    if (item?.type !== "URL" || item.data?.format !== "string") continue;
    if (typeof item.data.value !== "string") {
      throw new DOIError("could not resolve DOI (incorrect response format)");
    }
    value = item.data.value;
  }
  try {
    return new URL(value ?? "");
  } catch {
    throw new DOIError("could not resolve DOI (incorrect response format)");
  }
}

/**
 * The API of a record of Zenodo: the ID is the text after `zenodo.` in the
 * DOI, as rclone.
 * @param {string} name The DOI.
 * @param {URL} landing The URL of the DOI.
 * @returns {Promise<URL>}
 */
async function zenodoEndpoint(name, landing) {
  const match = /zenodo[.](.+)/.exec(name);
  if (!match) {
    throw new DOIError(`could not derive API endpoint URL from '${landing}'`);
  }
  const record = await getJSON(`${landing.origin}/api/records/${match[1]}`);
  return endpointOf(record, landing);
}

/**
 * The API of a record of an InvenioRDM server: the link `linkset` in the
 * header `Link` of the page of the DOI, else `/api/records/ID` for a page
 * `/records/ID`, as rclone.
 * @param {URL} landing The URL of the DOI.
 * @returns {Promise<URL>}
 */
async function invenioEndpoint(landing) {
  const page = await send(landing);
  await page.body?.cancel();
  const link = linksOf(page.headers.get("Link") ?? "").find((link) =>
    link.rel === "linkset" && link.type === "application/linkset+json"
  );
  if (link) {
    try {
      return endpointOf(await getJSON(link.href), landing);
    } catch {
      // The other way below.
    }
  }
  const final = new URL(page.url || landing);
  const match = /\/records?\/(.+)/.exec(final.pathname);
  if (match) {
    try {
      return endpointOf(
        await getJSON(`${final.origin}/api/records/${match[1]}`),
        landing,
      );
    } catch {
      // The error below.
    }
  }
  throw new DOIError(
    `could not resolve the Invenio API endpoint for '${landing}'`,
  );
}

/**
 * The URL `links.self` of a record of InvenioRDM.
 * @param {any} record
 * @param {URL} landing
 * @returns {URL}
 */
function endpointOf(record, landing) {
  try {
    return new URL(record?.links?.self);
  } catch {
    throw new DOIError(`could not parse API response from '${landing}'`);
  }
}

/**
 * Reads the links of a header `Link`, as rclone: the first part of each
 * link is `<URL>`, and the others are `name=value`.
 * @param {string} header
 * @returns {{ href: string, rel: string, type: string }[]}
 */
export function linksOf(header) {
  const links = [];
  for (const part of header.split(",")) {
    const [first, ...pieces] = part.trim().split(";");
    const match = /^<(.+)>$/.exec(first.trim());
    if (!match) continue;
    const link = { href: match[1], rel: "", type: "" };
    for (const piece of pieces) {
      const equal = piece.indexOf("=");
      if (equal === -1) continue;
      const key = piece.slice(0, equal).trim().toLowerCase();
      const value = piece.slice(equal + 1).trim().replace(/^"(.*)"$/, "$1");
      if (key === "rel" || key === "type") link[key] = value;
    }
    links.push(link);
  }
  return links;
}

/**
 * Reads the files of a record of InvenioRDM.
 * @param {URL} endpoint The API of the record.
 * @returns {Promise<DataFile[]>}
 */
async function invenioFiles(endpoint) {
  const answer = await getJSON(
    `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}/files`,
  );
  return (answer?.entries ?? []).map((entry) => ({
    path: `${entry?.key ?? ""}`,
    size: Number(entry?.size ?? -1),
    type: `${entry?.mimetype ?? ""}`,
    modTime: secondOf(entry?.updated),
    url: `${entry?.links?.content ?? ""}`,
  })).filter(isSafe);
}

/**
 * Reads the files of a dataset of Dataverse. A file in its original format
 * has its original name, size and type, as rclone.
 * @param {URL} landing The URL of the DOI.
 * @returns {Promise<DataFile[]>}
 */
async function dataverseFiles(landing) {
  const query = new URLSearchParams({
    persistentId: landing.searchParams.get("persistentId") ?? "",
  });
  const answer = await getJSON(
    `${landing.origin}/api/datasets/:persistentId/?${query}`,
  );
  const version = answer?.data?.latestVersion ?? {};
  const modTime = secondOf(version.lastUpdateTime);
  return (version.files ?? []).map((item) => {
    const file = item?.dataFile ?? {};
    const original = Boolean(file.originalFileName);
    const name = original ? file.originalFileName : file.filename;
    return {
      path: [item?.directoryLabel, name].filter(Boolean).join("/"),
      size: Number((original ? file.originalFileSize : file.filesize) ?? -1),
      type: `${(original ? file.originalFileFormat : file.contentType) ?? ""}`,
      modTime,
      url: `${landing.origin}/api/access/datafile/${file.id}?format=original`,
    };
  }).filter(isSafe);
}

/**
 * Tells if a path of a file of a provider can be a path of rfetch: no empty
 * name, and no `.` or `..`.
 * @param {DataFile} file
 */
function isSafe(file) {
  return file.path.split("/").every((name) =>
    name !== "" && name !== "." && name !== ".."
  );
}

/**
 * Writes a time of RFC 3339 to the second, as the precision of the backend
 * in rclone.
 * @param {unknown} value
 * @returns {string}
 */
function secondOf(value) {
  const time = Date.parse(`${value ?? ""}`);
  if (Number.isNaN(time)) return EPOCH;
  return new Date(Math.floor(time / 1000) * 1000).toISOString()
    .replace(/\.\d+Z$/, "Z");
}

/**
 * The entries of a folder: its files, then its folders, as rclone.
 * @param {DataFile[]} files
 * @param {string} folder The path of the folder, with a `/` at the end, or
 *   "" for the root.
 * @returns {import("@rfetch/lib/listing").Entry[] | null} null for a folder
 *   that does not exist.
 */
function list(files, folder) {
  /** @type {import("@rfetch/lib/listing").Entry[]} */
  const entries = [];
  const folders = new Set();
  let found = folder === "";
  for (const file of files) {
    if (!file.path.startsWith(folder)) continue;
    found = true;
    const rest = file.path.slice(folder.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      entries.push({
        Name: rest,
        IsDir: false,
        Size: file.size,
        MimeType: file.type || mimeType(rest),
        ModTime: file.modTime,
      });
    } else {
      folders.add(rest.slice(0, slash));
    }
  }
  if (!found) return null;
  for (const Name of folders) {
    entries.push({ Name, IsDir: true, Size: -1, MimeType: "", ModTime: "" });
  }
  return entries;
}

/**
 * Gets a file, or only its headers for HEAD, with the range of the request.
 * The headers come from the list of the provider: HEAD sends no request.
 * @param {DataFile} file
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function getFile(file, request) {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  const headers = new Headers({
    "Content-Type": file.type || mimeType(name),
    "Last-Modified": new Date(file.modTime).toUTCString(),
    "Accept-Ranges": "bytes",
  });
  if (file.size >= 0) headers.set("Content-Length", `${file.size}`);
  if (request.method === "HEAD") return new Response(null, { headers });

  let range = null;
  if (file.size >= 0) {
    try {
      range = parseRange(request.headers.get("Range"), file.size);
    } catch {
      return notSatisfiable(file.size);
    }
  }
  let response;
  try {
    response = await send(file.url);
    // As rclone: a server that gives a Location with a 2xx answer.
  } catch (error) {
    if (error instanceof DOIError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
  if (!range) {
    return new Response(
      file.size >= 0 ? sized(response.body, file.size) : response.body,
      { headers },
    );
  }
  return await rangeOf(file, range, headers, response);
}

/**
 * The answer 206 for a range of a file. The server of the file gets the
 * range: a server that does not read it gives all the file, and the backend
 * cuts it.
 * @param {DataFile} file
 * @param {{ start: number, end: number }} range
 * @param {Headers} headers
 * @param {Response} first The answer with no range, which the backend
 *   cancels.
 * @returns {Promise<Response>}
 */
async function rangeOf(file, range, headers, first) {
  await first.body?.cancel();
  const length = range.end - range.start + 1;
  let response;
  try {
    response = await fetch(file.url, {
      headers: { Range: `bytes=${range.start}-${range.end}` },
    });
  } catch {
    return new Response("The server of the file did not answer", {
      status: 502,
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    return new Response(null, { status: 502 });
  }
  let body = response.body;
  if (response.status !== 206) body = sliceStream(body, range.start, length);
  for (
    const [name, value] of Object.entries(partialHeaders(range, file.size))
  ) {
    headers.set(name, value);
  }
  return new Response(sized(body, length), { status: 206, headers });
}

export default {
  fetch: doi,
};
