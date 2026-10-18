/**
 * HTTP Backend
 *
 * The http backend reads the files of a web server, as the http backend of
 * rclone. It is read only: a request other than GET or HEAD gets 405.
 *
 * The options:
 *
 * - `url`: the URL of the root folder on the server. The path of a request
 *   goes after this URL. Thus with the URL `https://example.com/files` and
 *   the path `/a b/c.txt`, the file is at
 *   `https://example.com/files/a%20b/c.txt`.
 * - `headers`: the HTTP headers for each request to the server, as a list of
 *   names and values with commas, for example `Cookie,name=value`. The links
 *   of a list do not have this option, because it can have a password.
 * - `no_head`: when it is `true`, the list of a folder does not send a HEAD
 *   request for each file. Thus the list does not have the size and the time
 *   of a file that the index page does not give.
 *
 * A path that ends with `/` is a folder. The list of a folder comes from its
 * index page on the server: each link to a file or a folder directly in the
 * folder. The query and the fragment of a link are not a part of the name.
 *
 * To get only one file, use [copyurl](../../cmd/copyurl/main.js).
 */

import { HTMLRewriter } from "@sntran/html-rewriter";
import { parseList } from "./list.js";
import { childOf, renderListing } from "@rfetch/lib/listing";
import { mimeType } from "@rfetch/lib/mime";
import { optionsOf } from "@rfetch/lib/options";
import { decodePath, encodePath } from "@rfetch/lib/path";

export const options = {
  boolean: [
    "no_head",
  ],
  string: [
    "url",
    "headers",
  ],
  default: {
    no_head: false,
  },
};

/** The options that are secret, as `headers` can have a password. */
const SECRETS = ["headers"];

/** The headers of a file that go to the client. */
const FILE_HEADERS = [
  "Content-Type",
  "Content-Length",
  "Last-Modified",
  "Accept-Ranges",
  "Content-Range",
];

/** The status codes of a redirect. */
const REDIRECTS = [301, 302, 303, 307, 308];

/** The maximum number of redirects, as the HTTP client of Go. */
const MAX_REDIRECTS = 10;

/** The number of HEAD requests at the same time, as `--checkers` of rclone. */
const CHECKERS = 8;

/** An error that has the status of the response. */
class HTTPError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Serves a HTTP remote. It is read only, as the http backend of rclone.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_HTTP_*` or `RCLONE_HTTP_*`.
 * @returns {Promise<Response>}
 */
async function http(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);
  const options = optionsOf(request, "http", env);

  let base;
  try {
    base = new URL(options.get("url") ?? "");
  } catch {
    return new Response("The url option is not a URL", { status: 400 });
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    return new Response("The url option must be an http or https URL", {
      status: 400,
    });
  }
  // A path resolves relative to the URL of the remote, as a folder.
  if (!base.pathname.endsWith("/")) base.pathname += "/";

  const path = decodePath(pathname);
  if (path === null) {
    return new Response(null, { status: 400 });
  }
  if (method !== "GET" && method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  let headers;
  try {
    headers = parseHeaders(options.get("headers") ?? "");
  } catch (error) {
    return new Response(`The headers option is not correct: ${error.message}`, {
      status: 400,
    });
  }

  const target = new URL(encodePath(path).slice(1), base);
  try {
    if (!path.endsWith("/")) {
      return await getFile(target, method, headers, path, request);
    }
    const noHead = options.get("no_head") === "true";
    const query = new URLSearchParams(searchParams);
    for (const name of SECRETS) query.delete(name);
    return await getFolder(target, method, headers, noHead, `${query}`);
  } catch (error) {
    if (error instanceof HTTPError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
}

/**
 * Reads the headers option of rclone: a list of names and values, for
 * example `Cookie,name=value,Authorization,"Basic a2V5"`.
 * @param {string} text
 * @returns {Headers}
 * @throws {SyntaxError | TypeError} When the list is not correct, or when a
 *   name or a value is not correct for HTTP.
 */
function parseHeaders(text) {
  const list = parseList(text);
  if (list.length % 2 !== 0) {
    throw new SyntaxError("odd number of headers supplied");
  }
  const headers = new Headers();
  for (let index = 0; index < list.length; index += 2) {
    headers.append(list[index], list[index + 1]);
  }
  return headers;
}

/**
 * Gets a file, or only its headers for HEAD. The server gets the `Range` of
 * the request, and the client gets the answer 206 or 416 of the server.
 * @param {URL} url
 * @param {string} method
 * @param {Headers} headers
 * @param {string} path
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function getFile(url, method, headers, path, request) {
  const range = request.headers.get("Range");
  const response = await send(
    url,
    method,
    headers,
    method === "GET" && range !== null ? { Range: range } : {},
  );
  if (!response.ok) {
    await response.body?.cancel();
    const result = new Headers();
    const contentRange = response.headers.get("Content-Range");
    if (response.status === 416 && contentRange) {
      result.set("Content-Range", contentRange);
    }
    return new Response(null, { status: response.status, headers: result });
  }

  const result = new Headers();
  for (const name of FILE_HEADERS) {
    const value = response.headers.get(name);
    if (value) result.set(name, value);
  }
  if (!result.has("Content-Type")) result.set("Content-Type", mimeType(path));
  // The body of fetch has no content encoding, thus it has an other size.
  if (isEncoded(response)) result.delete("Content-Length");

  if (method === "HEAD") {
    await response.body?.cancel();
    return new Response(null, { headers: result });
  }
  return new Response(response.body, {
    status: response.status,
    headers: result,
  });
}

/**
 * Gets the list of a folder, from the index page of the server, or only the
 * headers for HEAD.
 * @param {URL} url
 * @param {string} method
 * @param {Headers} headers
 * @param {boolean} noHead When it is false, a HEAD request gives the size,
 *   the time and the type of each file that the index page does not give.
 * @param {string} query The query for each link, with no secret.
 * @returns {Promise<Response>}
 */
async function getFolder(url, method, headers, noHead, query) {
  const response = await send(url, "GET", headers);
  if (!response.ok) {
    await response.body?.cancel();
    return new Response(null, { status: response.status });
  }
  // As in rclone, only an HTML page can be the list of a folder.
  const type = response.headers.get("Content-Type") ?? "";
  if (type.split(";")[0].trim().toLowerCase() !== "text/html") {
    await response.body?.cancel();
    return new Response("The index page of the folder is not HTML", {
      status: 502,
    });
  }

  const result = { "Content-Type": "text/html;charset=utf-8" };
  if (method === "HEAD") {
    await response.body?.cancel();
    return new Response(null, { headers: result });
  }

  let entries = await readIndex(response, url);
  if (!noHead) entries = await head(entries, url, headers);
  for (const entry of entries) {
    if (!entry.IsDir) entry.MimeType ||= mimeType(entry.Name);
  }
  return new Response(renderListing(entries, { query }), { headers: result });
}

/**
 * Reads the files and the folders of an index page, as `parse` of the http
 * backend of rclone: each link to a child of the folder, one time. The rows
 * of a table of rfetch also give the size and the time.
 * @param {Response} response
 * @param {URL} base The URL of the folder.
 * @returns {Promise<import("@rfetch/lib/listing").Entry[]>}
 */
async function readIndex(response, base) {
  /** @type {import("@rfetch/lib/listing").Entry[]} */
  const entries = [];
  const seen = new Set();
  let inRow = false;
  /** @type {import("@rfetch/lib/listing").Entry | null} */
  let current = null;

  await new HTMLRewriter()
    .on("tr", {
      element(element) {
        inRow = true;
        current = null;
        element.onEndTag(() => {
          inRow = false;
          current = null;
        });
      },
    })
    .on("a[href]", {
      element(element) {
        const name = childOf(element.getAttribute("href"), base);
        if (name === null || seen.has(name)) return;
        seen.add(name);
        const isDir = name.endsWith("/");
        const entry = {
          Name: isDir ? name.slice(0, -1) : name,
          IsDir: isDir,
          Size: -1,
          MimeType: isDir ? "" : element.getAttribute("type") || "",
          ModTime: "",
        };
        entries.push(entry);
        if (inRow) current = entry;
      },
    })
    .on("tr data[value]", {
      element(element) {
        const value = element.getAttribute("value");
        if (current && /^\d+$/.test(value)) current.Size = Number(value);
      },
    })
    .on("tr time[datetime]", {
      element(element) {
        const time = Date.parse(element.getAttribute("datetime"));
        if (current && !isNaN(time)) {
          current.ModTime = new Date(time).toISOString();
        }
      },
    })
    .transform(response)
    .arrayBuffer();

  return entries;
}

/**
 * Sends a HEAD request for each file with no size, as rclone does for each
 * file of a list. As in rclone, a file is not in the list when its HEAD
 * request fails.
 * @param {import("@rfetch/lib/listing").Entry[]} entries
 * @param {URL} base The URL of the folder.
 * @param {Headers} headers
 * @returns {Promise<import("@rfetch/lib/listing").Entry[]>}
 */
async function head(entries, base, headers) {
  const files = entries.filter((entry) => !entry.IsDir && entry.Size < 0);
  const failed = new Set();
  const next = async () => {
    for (let entry = files.shift(); entry; entry = files.shift()) {
      const url = new URL(encodeURIComponent(entry.Name), base);
      let response;
      try {
        response = await send(url, "HEAD", headers);
      } catch {
        failed.add(entry);
        continue;
      }
      await response.body?.cancel();
      if (!response.ok) {
        failed.add(entry);
        continue;
      }
      entry.Size = isEncoded(response) ? -1 : sizeOf(response.headers);
      const time = Date.parse(response.headers.get("Last-Modified") ?? "");
      if (!isNaN(time)) entry.ModTime = new Date(time).toISOString();
      entry.MimeType = response.headers.get("Content-Type") ?? "";
    }
  };
  await Promise.all(Array.from({ length: CHECKERS }, next));
  return entries.filter((entry) => !failed.has(entry));
}

/**
 * The size of a file from the headers of a response, as
 * `ParseSizeFromHeaders` of rclone: `Content-Length`, or the size at the end
 * of `Content-Range`, or -1.
 * @param {Headers} headers
 * @returns {number}
 */
function sizeOf(headers) {
  const range = headers.get("Content-Range");
  if (range !== null) {
    const match = range.match(/^bytes [^/]*\/(\d+)$/);
    return match ? Number(match[1]) : -1;
  }
  const length = headers.get("Content-Length") ?? "";
  return /^\d+$/.test(length) ? Number(length) : -1;
}

/**
 * Tells if the body of a response has a content encoding, for example gzip.
 * @param {Response} response
 */
function isEncoded(response) {
  const encoding = response.headers.get("Content-Encoding");
  return encoding !== null && encoding.toLowerCase() !== "identity";
}

/**
 * Sends a request to the server, with the headers of the headers option.
 *
 * As in rclone, when there are such headers, a redirect from HTTPS to HTTP is
 * an error, and the headers do not go to a server on a different host. After
 * a redirect to a different host, the headers do not go to the next redirects
 * too, as that host chose them.
 * @param {URL} url
 * @param {string} method GET or HEAD.
 * @param {Headers} headers The headers of the headers option.
 * @param {Record<string, string>} [others] Other headers, for example
 *   `Range`, which go to each server.
 * @returns {Promise<Response>}
 * @throws {HTTPError} When the server does not answer, or when a redirect is
 *   not permitted.
 */
async function send(url, method, headers, others = {}) {
  const names = [...headers.keys()];
  const init = {
    method,
    headers: new Headers(headers),
    redirect: names.length > 0 ? "manual" : "follow",
  };
  for (const [name, value] of Object.entries(others)) {
    init.headers.set(name, value);
  }
  // The size of the file is the size of the body that the client gets.
  if (!init.headers.has("Accept-Encoding")) {
    init.headers.set("Accept-Encoding", "identity");
  }

  const first = url;
  for (let redirects = 0;; redirects++) {
    let response;
    try {
      response = await fetch(url, init);
    } catch {
      throw new HTTPError("The server did not answer", 502);
    }
    const location = response.headers.get("Location");
    if (
      init.redirect === "follow" || !REDIRECTS.includes(response.status) ||
      location === null
    ) {
      return response;
    }
    await response.body?.cancel();

    if (redirects === MAX_REDIRECTS) {
      throw new HTTPError(`stopped after ${MAX_REDIRECTS} redirects`, 502);
    }
    const next = new URL(location, url);
    if (first.protocol === "https:" && next.protocol === "http:") {
      throw new HTTPError(
        "A redirect from HTTPS to HTTP is not permitted with the headers option",
        502,
      );
    }
    if (!sameHost(next, first)) {
      for (const name of names) init.headers.delete(name);
    }
    url = next;
  }
}

/**
 * Tells if two URLs have the same host and port, as `SameHost` of rclone.
 * @param {URL} a
 * @param {URL} b
 */
function sameHost(a, b) {
  const port = (url) =>
    url.port || { "http:": "80", "https:": "443" }[url.protocol];
  return a.hostname === b.hostname && port(a) === port(b);
}

export default {
  fetch: http,
};
