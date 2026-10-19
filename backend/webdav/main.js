/**
 * WebDAV backend
 *
 * The webdav backend reads and writes the files of a WebDAV server, as the
 * webdav backend of rclone: for example Nextcloud, ownCloud, Fastmail Files,
 * Apache, nginx and `rclone serve webdav`.
 *
 * The options, as rclone:
 *
 * - `url`: the URL of the root folder on the server, for example
 *   `https://example.com/remote.php/dav/files/user/`. The path of a request
 *   goes after this URL. The URL cannot have a user or a password: put them
 *   in `user` and `pass`.
 * - `vendor`: the server, for its quirks: `fastmail`, `nextcloud`,
 *   `owncloud`, `infinitescale`, `rclone` or `other`, the default. rfetch
 *   does not know `sharepoint` and `sharepoint-ntlm`: they need a login of
 *   Microsoft or NTLM.
 * - `user` and `pass`: the user and the password for the Basic
 *   authentication. `pass` is obscured, as in rclone.
 * - `bearer_token`: a token for the header `Authorization: Bearer`, in the
 *   place of `user` and `pass`.
 * - `headers`: the HTTP headers for each request to the server, as a list
 *   of names and values with commas, for example `Cookie,name=value`.
 * - `owncloud_exclude_shares` and `owncloud_exclude_mounts`: when they are
 *   `true`, a list does not show the shared folders, or the mounted storage,
 *   of ownCloud and Nextcloud.
 * - `auth_redirect`: when it is `true`, the authentication and the headers
 *   go to the server of a redirect on a different host, and a redirect from
 *   HTTPS to HTTP is permitted. Else they do not go there, and such a
 *   redirect is an error.
 *
 * rfetch accepts `pacer_min_sleep` and `nextcloud_chunk_size` of rclone, but
 * they do nothing: rfetch sends each request one time, and a file in one
 * PUT. rfetch runs no command, thus `bearer_token_command` gives 501. The
 * options `unix_socket` and `encoding` give 501 too.
 *
 * The requests to the server:
 *
 * - The list of a folder is a PROPFIND with `Depth: 1`, and HEAD of a
 *   folder is a PROPFIND with `Depth: 0`, as in rclone.
 * - GET and HEAD of a file go to the server, with the `Range` of the
 *   request.
 * - PUT of a folder is MKCOL, after the MKCOL of the parent folders that do
 *   not exist, as rclone. PUT of a file makes its folder first, as rclone.
 * - DELETE goes to the server. The server deletes a folder with all that is
 *   in it.
 * - COPY of a file, and MOVE of a file or a folder, go to the server, with
 *   the URL of the destination and `Overwrite: T`, after the MKCOL of the
 *   folder of the destination, as rclone. A folder moves only to a path that
 *   does not exist.
 *
 * The time of a file, as rclone: a PUT with `X-OC-Mtime` sends that header,
 * in whole seconds, to the vendors that know it: `fastmail`, `owncloud`,
 * `nextcloud`, `infinitescale` and `rclone`. For `owncloud`, `nextcloud`
 * and `infinitescale`, a COPY and a MOVE send it too, and when the server
 * does not answer `X-OC-Mtime: accepted`, a PROPPATCH of `lastmodified`
 * sets the time. A PATCH with `X-OC-Mtime` is that PROPPATCH. The other
 * vendors cannot set the time of a file that exists: their PATCH gives 405.
 * `rclone serve webdav` gives the time of a COPY to the source file, not to
 * the copy: thus the backend does not send it there.
 *
 * The list has the times of the server, to the second. The type of a file
 * comes from its name, as in rclone.
 */
import { parseHeaders } from "@rfetch/lib/headers";
import { renderListing } from "@rfetch/lib/listing";
import { mimeType } from "@rfetch/lib/mime";
import { reveal } from "@rfetch/lib/obscure";
import { isTrue, optionsOf } from "@rfetch/lib/options";
import { decodePath, encodePath } from "@rfetch/lib/path";
import { isOneRange } from "@rfetch/lib/range";
import { sized } from "@rfetch/lib/sized";
import { modTimeOf } from "@rfetch/lib/time";
import { childrenOf, parseXML, textOf } from "@rfetch/lib/xml";

export const options = {
  boolean: [
    "auth_redirect",
    "owncloud_exclude_mounts",
    "owncloud_exclude_shares",
  ],
  string: [
    "bearer_token",
    "bearer_token_command",
    "encoding",
    "headers",
    "nextcloud_chunk_size",
    "pacer_min_sleep",
    "pass",
    "unix_socket",
    "url",
    "user",
    "vendor",
  ],
};

/**
 * The options that are secret. The links of a list do not have them.
 */
const SECRETS = [
  "bearer_token",
  "bearer_token_command",
  "headers",
  "pass",
  "user",
];

/**
 * The quirks of a server, as `setQuirks` of rclone.
 * @typedef {Object} Vendor
 * @property {string} props The body of a PROPFIND.
 * @property {boolean} stream The server takes a body of unknown size.
 * @property {boolean} ocMtime The server sets the time of `X-OC-Mtime` on
 *   a PUT, as `useOCMtime` of rclone.
 * @property {boolean} propset A PROPPATCH of `lastmodified` sets the time
 *   of a file, as `propsetMtime` of rclone.
 */

/** @type {Record<string, Vendor>} */
const VENDORS = {
  fastmail: { props: "", stream: true, ocMtime: true, propset: false },
  owncloud: { props: "owncloud", stream: true, ocMtime: true, propset: true },
  infinitescale: {
    props: "owncloud",
    stream: false,
    ocMtime: true,
    propset: true,
  },
  nextcloud: { props: "owncloud", stream: false, ocMtime: true, propset: true },
  rclone: { props: "", stream: true, ocMtime: true, propset: false },
  other: { props: "standard", stream: false, ocMtime: false, propset: false },
};

/** The body of a PROPPATCH that sets the time of a file, as rclone. */
const PROPSET = (seconds) =>
  `<?xml version="1.0" encoding="utf-8" ?>
<D:propertyupdate xmlns:D="DAV:">
 <D:set>
  <D:prop>
   <lastmodified xmlns="DAV:">${seconds}</lastmodified>
  </D:prop>
 </D:set>
</D:propertyupdate>
`;

/** The bodies of PROPFIND, as rclone. With no body, the server gives all. */
const PROPS = {
  owncloud: `<?xml version="1.0"?>
<d:propfind  xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
 <d:prop>
  <d:displayname />
  <d:getlastmodified />
  <d:getcontentlength />
  <d:resourcetype />
  <oc:checksums />
  <oc:permissions />
 </d:prop>
</d:propfind>
`,
  standard: `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
 <d:prop>
  <d:displayname/>
  <d:getlastmodified/>
  <d:getcontentlength/>
  <d:resourcetype/>
 </d:prop>
</d:propfind>
`,
};

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

/** The time of a file with no time, or with a time that rclone cannot read. */
const EPOCH = "1970-01-01T00:00:00Z";

/** An error that has the status of the answer to the client. */
class WebDAVError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * The configuration of the requests to a server.
 * @typedef {Object} Config
 * @property {URL} base The URL of the root folder, with a `/` at the end.
 * @property {Headers} headers The headers of each request: the
 *   authentication, the option `headers` and `Referer`.
 * @property {string[]} secrets The names of the headers that do not go to
 *   a server on a different host.
 * @property {Vendor} vendor
 * @property {boolean} authRedirect
 * @property {boolean} excludeShares
 * @property {boolean} excludeMounts
 */

/**
 * Serves a WebDAV remote.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_WEBDAV_*` or `RCLONE_WEBDAV_*`.
 * @returns {Promise<Response>}
 */
async function webdav(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);
  const options = optionsOf(request, "webdav", env);

  /** @type {Config} */
  let config;
  try {
    config = await configOf(options);
  } catch (error) {
    await request.body?.cancel();
    if (error instanceof WebDAVError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }

  const path = decodePath(pathname);
  if (path === null) {
    await request.body?.cancel();
    return new Response(null, { status: 400 });
  }
  const url = new URL(encodePath(path).slice(1), config.base);
  const isFolder = path.endsWith("/");
  const modTime = modTimeOf(request);
  if (modTime === undefined) {
    await request.body?.cancel();
    return new Response("X-OC-Mtime is not a time", { status: 400 });
  }

  try {
    if (method === "GET" || method === "HEAD") {
      if (!isFolder) return await getFile(config, url, path, request);
      const query = new URLSearchParams(searchParams);
      for (const name of SECRETS) query.delete(name);
      return await getFolder(config, url, method, `${query}`);
    }
    if (method === "PUT") {
      /** @type {Record<string, string>} */
      const headers = { "Content-Location": pathname };
      if (isFolder) {
        await request.body?.cancel();
        await mkdir(config, url);
      } else if (await putFile(config, url, path, request, modTime)) {
        headers["X-OC-Mtime"] = "accepted";
      }
      return new Response(null, { status: 201, headers });
    }
    if (method === "DELETE") {
      await remove(config, url);
      return new Response(null, { status: 204 });
    }
    if (method === "COPY" || method === "MOVE") {
      await request.body?.cancel();
      const target = decodePath(request.headers.get("Destination") ?? "");
      if (target === null) {
        return new Response("Destination is not a path", { status: 400 });
      }
      return await transfer(config, method, url, target, modTime);
    }
    if (method === "PATCH" && !isFolder && config.vendor.propset) {
      await request.body?.cancel();
      if (modTime === null) {
        return new Response("X-OC-Mtime is missing", { status: 400 });
      }
      if (!await proppatch(config, url, modTime)) {
        return new Response("can't set modified time", { status: 501 });
      }
      return new Response(null, {
        status: 204,
        headers: { "X-OC-Mtime": "accepted" },
      });
    }
    await request.body?.cancel();
    return new Response(null, {
      status: 405,
      headers: { Allow: "GET, HEAD, PUT, DELETE, COPY, MOVE" },
    });
  } catch (error) {
    await request.body?.cancel().catch(() => {});
    if (error instanceof WebDAVError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
}

/**
 * Reads the options of a request.
 * @param {URLSearchParams} options
 * @returns {Promise<Config>}
 * @throws {WebDAVError} When an option is not correct, or when rfetch does
 *   not know it.
 */
async function configOf(options) {
  let base;
  try {
    base = new URL(options.get("url") ?? "");
  } catch {
    throw new WebDAVError("The url option is not a URL", 400);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new WebDAVError("The url option must be an http or https URL", 400);
  }
  if (base.username || base.password) {
    throw new WebDAVError(
      "The url option cannot have a user or a password: use user and pass",
      400,
    );
  }
  // A path goes after the URL of the remote, as in a folder.
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  base.search = "";
  base.hash = "";

  const name = options.get("vendor") || "other";
  if (!Object.hasOwn(VENDORS, name)) {
    throw new WebDAVError(`rfetch does not know the vendor ${name}`, 501);
  }
  for (const option of ["bearer_token_command", "unix_socket"]) {
    if (options.get(option)) {
      throw new WebDAVError(`rfetch does not know the option ${option}`, 501);
    }
  }
  const encoding = options.get("encoding") ?? "";
  if (encoding !== "" && encoding.toLowerCase() !== "none") {
    throw new WebDAVError("rfetch does not know the option encoding", 501);
  }

  let headers;
  try {
    headers = parseHeaders(options.get("headers") ?? "");
  } catch (error) {
    throw new WebDAVError(
      `The headers option is not correct: ${error.message}`,
      400,
    );
  }
  const secrets = [...headers.keys()];

  const user = options.get("user") ?? "";
  const obscured = options.get("pass") ?? "";
  const token = options.get("bearer_token") ?? "";
  if (user || obscured) {
    let pass = "";
    if (obscured) {
      try {
        pass = await (await reveal(obscured)).text();
      } catch {
        throw new WebDAVError("couldn't decrypt password", 400);
      }
    }
    headers.set("Authorization", `Basic ${base64(`${user}:${pass}`)}`);
    secrets.push("authorization");
  } else if (token) {
    headers.set("Authorization", `Bearer ${token}`);
    secrets.push("authorization");
  }
  // As rclone: some servers check the Referer.
  if (!headers.has("Referer")) headers.set("Referer", base.href);

  return {
    base,
    headers,
    secrets,
    vendor: VENDORS[name],
    authRedirect: isTrue(options.get("auth_redirect")),
    excludeShares: isTrue(options.get("owncloud_exclude_shares")),
    excludeMounts: isTrue(options.get("owncloud_exclude_mounts")),
  };
}

/**
 * Gets a file, or only its headers for HEAD. The server gets the `Range` of
 * the request, and the client gets the answer 206 or 416 of the server.
 * @param {Config} config
 * @param {URL} url
 * @param {string} path
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function getFile(config, url, path, request) {
  const { method } = request;
  const range = request.headers.get("Range");
  // The server gets only one range that is correct: else the client gets
  // all the file.
  const headers = method === "GET" && isOneRange(range) ? { Range: range } : {};
  const { response } = await send(config, method, url, { headers });
  if (!response.ok) {
    await response.body?.cancel();
    const result = new Headers();
    const contentRange = response.headers.get("Content-Range");
    if (response.status === 416 && contentRange) {
      result.set("Content-Range", contentRange);
    }
    // A server such as `rclone serve webdav` gives 405 to GET of a folder:
    // the path is not a file.
    const status = response.status === 405 ? 404 : response.status;
    return new Response(null, { status, headers: result });
  }

  const result = new Headers();
  for (const name of FILE_HEADERS) {
    const value = response.headers.get(name);
    if (value) result.set(name, value);
  }
  if (!result.has("Content-Type")) result.set("Content-Type", mimeType(path));
  // The body of fetch has no content encoding, thus it has another size.
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
 * Gets the list of a folder, or only the headers for HEAD.
 * @param {Config} config
 * @param {URL} url The URL of the folder, with a `/` at the end.
 * @param {string} method
 * @param {string} query The query of each link, with no secret.
 * @returns {Promise<Response>}
 */
async function getFolder(config, url, method, query) {
  const items = await propfind(config, url, method === "GET" ? "1" : "0");
  const self = items.find((item) => item.name === "");
  if (self && !self.isDir) {
    throw new WebDAVError("not a folder", 404);
  }
  const headers = { "Content-Type": "text/html;charset=utf-8" };
  if (method === "HEAD") return new Response(null, { headers });

  /** @type {import("@rfetch/lib/listing").Entry[]} */
  const entries = [];
  for (const item of items) {
    // A name with a "/" is in a folder of the folder, and a name with a NUL
    // had a "/" in its percent-encoding.
    if (item.name === "" || /[/\0]/.test(item.name)) continue;
    if (config.excludeShares && item.permissions.includes("S")) continue;
    if (config.excludeMounts && item.permissions.includes("M")) continue;
    entries.push({
      Name: item.name,
      IsDir: item.isDir,
      Size: item.isDir ? -1 : item.size,
      MimeType: item.isDir ? "" : mimeType(item.name),
      ModTime: item.modTime,
    });
  }
  return new Response(renderListing(entries, { query }), { headers });
}

/**
 * A file or a folder in the answer of a PROPFIND.
 * @typedef {Object} Item
 * @property {string} name The path from the folder of the PROPFIND, with no
 *   `/` at the end, and "" for the folder.
 * @property {boolean} isDir
 * @property {number} size
 * @property {string} modTime
 * @property {string} permissions The permissions of ownCloud, or "".
 */

/**
 * Sends a PROPFIND, and reads the items of its answer, as `listAll` of
 * rclone: an item with a status that is not 2xx is not in the result.
 * @param {Config} config
 * @param {URL} url The URL of a folder, with a `/` at the end.
 * @param {"0" | "1"} depth
 * @returns {Promise<Item[]>}
 * @throws {WebDAVError} With 404 when the folder does not exist.
 */
async function propfind(config, url, depth) {
  const props = PROPS[config.vendor.props];
  /** @type {Record<string, string>} */
  const headers = { Depth: depth };
  if (props) headers["Content-Type"] = "application/xml; charset=utf-8";
  const { response, url: final } = await send(config, "PROPFIND", url, {
    headers,
    body: props || undefined,
  });
  if (response.status !== 207) {
    if (!response.ok) await failed(response);
    // A server that does not know PROPFIND, or a folder with no WebDAV.
    await response.body?.cancel();
    throw new WebDAVError(
      `The server gave ${response.status} to PROPFIND`,
      502,
    );
  }
  let root;
  try {
    root = parseXML(await response.text());
  } catch (error) {
    throw new WebDAVError(
      `The answer to PROPFIND is not XML: ${error.message}`,
      502,
    );
  }
  const folder = decodeNames(final.pathname);
  /** @type {Item[]} */
  const items = [];
  for (const response of childrenOf(root, "response")) {
    const href = textOf(response, "href").trim();
    if (!href) continue;
    let target;
    try {
      target = new URL(href, final);
    } catch {
      continue;
    }
    const path = decodeNames(target.pathname);
    if (path === null || folder === null) continue;
    let name;
    if (`${path}/` === folder) {
      // The folder of the PROPFIND, with no "/" at the end: a server can
      // give a file for the path of a folder.
      name = "";
    } else if (path.startsWith(folder)) {
      // As rclone: a "/" at the start is not a part of the name, for
      // davrods.
      name = path.slice(folder.length).replace(/^\//, "").replace(/\/$/, "");
    } else {
      continue;
    }
    const item = itemOf(response, name);
    if (item) items.push(item);
  }
  return items;
}

/**
 * Reads the properties of a response of a multistatus, from its propstat
 * with a status 2xx, or with no status.
 * @param {import("@rfetch/lib/xml").XMLElement} response
 * @param {string} name
 * @returns {Item | null} null when no propstat has a status 2xx.
 */
function itemOf(response, name) {
  const propstats = childrenOf(response, "propstat");
  const good = propstats.filter((propstat) => {
    const status = textOf(propstat, "status");
    return status === "" || /^HTTP\/[\d.]+\s+2\d\d/.test(status.trim());
  });
  if (propstats.length > 0 && good.length === 0) return null;
  const props = good.flatMap((propstat) => childrenOf(propstat, "prop"));
  /** @param {string} name */
  const find = (name) => props.flatMap((prop) => childrenOf(prop, name))[0];

  let isDir = (find("resourcetype")?.children ?? [])
    .some((child) => child.name === "collection");
  // The Microsoft extension `iscollection`, as rclone.
  const collection = find("iscollection")?.text.trim().toLowerCase();
  if (!isDir && (collection === "1" || collection === "true")) isDir = true;

  const length = (find("getcontentlength")?.text ?? "").trim();
  return {
    name,
    isDir,
    size: /^\d+$/.test(length) ? Number(length) : 0,
    modTime: parseTime(find("getlastmodified")?.text.trim() ?? ""),
    permissions: find("permissions")?.text ?? "",
  };
}

/** The months of the times of HTTP. */
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/**
 * Reads the time of `getlastmodified` in the formats that rclone reads: RFC
 * 1123, with a zone name or a numeric zone, with the day in one or two
 * digits, the format of `date` of Unix, and RFC 3339. A zone name is UTC, as
 * Go reads a zone name that it does not know. As rclone, an empty time or a
 * time that it cannot read is the time 0 of Unix.
 * @param {string} text For example `Wed, 27 Sep 2017 14:28:34 GMT`.
 * @returns {string} The time in ISO 8601, for example
 *   `2017-09-27T14:28:34Z`.
 */
export function parseTime(text) {
  let match = text.match(
    /^[a-z]{3},\s+(\d{1,2}) ([a-z]{3}) (\d{4}) (\d\d):(\d\d):(\d\d) (?:[a-z]{2,5}|([+-])(\d\d)(\d\d))$/i,
  );
  let parts;
  if (match) {
    const [, day, month, year, hour, minute, second, sign, zh, zm] = match;
    parts = { day, month, year, hour, minute, second, sign, zh, zm };
  } else if (
    (match = text.match(
      /^[a-z]{3} ([a-z]{3}) {1,2}(\d{1,2}) (\d\d):(\d\d):(\d\d) [a-z]{2,5} (\d{4})$/i,
    ))
  ) {
    const [, month, day, hour, minute, second, year] = match;
    parts = { day, month, year, hour, minute, second };
  } else if (
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i.test(text)
  ) {
    const time = Date.parse(text);
    return isNaN(time) ? EPOCH : isoTime(time);
  } else {
    return EPOCH;
  }
  const month = MONTHS.indexOf(parts.month.toLowerCase());
  const [year, day, hour, minute, second] = [
    parts.year,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ].map(Number);
  if (
    month === -1 || day < 1 || day > 31 || hour > 23 || minute > 59 ||
    second > 59
  ) {
    return EPOCH;
  }
  let time = Date.UTC(year, month, day, hour, minute, second);
  // A date such as 31 February is not a date.
  if (new Date(time).getUTCDate() !== day) return EPOCH;
  if (parts.sign) {
    const offset = (Number(parts.zh) * 60 + Number(parts.zm)) * 60_000;
    time += parts.sign === "+" ? -offset : offset;
  }
  return isoTime(time);
}

/**
 * Writes a time in ISO 8601, with no milliseconds when they are 0.
 * @param {number} time
 */
function isoTime(time) {
  return new Date(time).toISOString().replace(/\.000Z$/, "Z");
}

/**
 * Makes a folder, as `mkdir` of rclone: MKCOL, and the MKCOL of its parent
 * folders when the server gives 409. A folder that exists is not an error.
 * @param {Config} config
 * @param {URL} url The URL of the folder, with a `/` at the end.
 */
async function mkdir(config, url) {
  if (url.href === config.base.href) return;
  let { response } = await send(config, "MKCOL", url);
  if (response.status === 409) {
    await response.body?.cancel();
    await mkdir(config, new URL("..", url));
    ({ response } = await send(config, "MKCOL", url));
  }
  if (response.ok) {
    await response.body?.cancel();
    return;
  }
  // As rclone: 405, 406 and 423 tell that the folder exists.
  if ([405, 406, 423].includes(response.status)) {
    await response.body?.cancel();
    return;
  }
  // Some servers give another status for a folder that exists.
  const status = response.status;
  await response.body?.cancel();
  const exists = await propfind(config, url, "0").then(
    (items) => items.find((item) => item.name === "")?.isDir ?? false,
    () => false,
  );
  if (!exists) {
    throw new WebDAVError(`The server gave ${status} to MKCOL`, status);
  }
}

/**
 * Puts a file. Its folder comes first, as rclone. A body of unknown size
 * goes in chunks to a server that takes them, else it comes into memory
 * first: as rclone, some servers need the size.
 * @param {Config} config
 * @param {URL} url
 * @param {string} path
 * @param {Request} request
 * @param {bigint | null} modTime The time of the file, or null.
 * @returns {Promise<boolean>} True when the file has the time.
 */
async function putFile(config, url, path, request, modTime) {
  await mkdir(config, new URL(".", url));
  const header = request.headers.get("Content-Length");
  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": request.headers.get("Content-Type") ||
      mimeType(path.slice(path.lastIndexOf("/") + 1)),
  };
  const timed = modTime !== null && config.vendor.ocMtime;
  if (timed) headers["X-OC-Mtime"] = `${secondsOf(modTime)}`;
  /** @type {BodyInit} */
  let body;
  if (header !== null && /^\d+$/.test(header)) {
    headers["Content-Length"] = header;
    body = sized(request.body ?? new Blob([]).stream(), Number(header));
  } else if (config.vendor.stream) {
    body = request.body ?? new Uint8Array(0);
  } else {
    body = new Uint8Array(await request.arrayBuffer());
    headers["Content-Length"] = `${body.length}`;
  }
  const { response } = await send(config, "PUT", url, { headers, body });
  if (!response.ok) await failed(response);
  await response.body?.cancel();
  if (!timed) return false;
  // As rclone: a server of a vendor with no PROPPATCH sets the time.
  if (
    response.headers.get("X-OC-Mtime") === "accepted" || !config.vendor.propset
  ) {
    return true;
  }
  return await proppatch(config, url, modTime);
}

/**
 * Copies a file, or moves a file or a folder, on the server, as `Copy`,
 * `Move` and `DirMove` of rclone.
 * @param {Config} config
 * @param {"COPY" | "MOVE"} method
 * @param {URL} url The URL of the source.
 * @param {string} target The path of the destination.
 * @param {bigint | null} modTime The time of the file, or null.
 * @returns {Promise<Response>}
 */
async function transfer(config, method, url, target, modTime) {
  const destination = new URL(encodePath(target).slice(1), config.base);
  const isFolder = url.pathname.endsWith("/");
  if (isFolder) {
    if (method === "COPY") {
      return new Response("COPY of a folder is not implemented", {
        status: 501,
      });
    }
    if (!target.endsWith("/") || destination.href.startsWith(url.href)) {
      return new Response("Destination is not a new folder", { status: 400 });
    }
    // As rclone: a folder does not move over a folder.
    if (await exists(config, destination)) {
      return new Response("Destination exists", { status: 412 });
    }
    await mkdir(config, new URL("..", destination));
  } else {
    if (target.endsWith("/")) {
      return new Response("Destination is a folder", { status: 409 });
    }
    await mkdir(config, new URL(".", destination));
  }
  /** @type {Record<string, string>} */
  const headers = { Destination: destination.href, Overwrite: "T" };
  const timed = modTime !== null && !isFolder && config.vendor.propset;
  if (timed) headers["X-OC-Mtime"] = `${secondsOf(modTime)}`;
  const { response } = await send(config, method, url, { headers });
  if (!response.ok) {
    // A server can give another error for a source that does not exist:
    // `rclone serve webdav` gives 403 to a MOVE.
    if (response.status !== 404 && !await exists(config, url)) {
      await response.body?.cancel();
      throw new WebDAVError("Not Found", 404);
    }
    await failed(response);
  }
  await response.body?.cancel();
  const status = isFolder ? 201 : response.status;
  if (
    timed && (response.headers.get("X-OC-Mtime") === "accepted" ||
      await proppatch(config, destination, modTime))
  ) {
    return new Response(null, {
      status,
      headers: { "X-OC-Mtime": "accepted" },
    });
  }
  return new Response(null, { status });
}

/**
 * Tells if a file or a folder exists, with a PROPFIND with `Depth: 0`.
 * @param {Config} config
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
async function exists(config, url) {
  return await propfind(config, url, "0").then(
    (items) => items.length > 0,
    (error) => {
      if (error instanceof WebDAVError && error.status === 404) return false;
      throw error;
    },
  );
}

/**
 * Sets the time of a file with a PROPPATCH of `lastmodified`, as
 * `SetModTime` of rclone for ownCloud and Nextcloud.
 * @param {Config} config
 * @param {URL} url
 * @param {bigint} modTime
 * @returns {Promise<boolean>} True when the server set the time.
 * @throws {WebDAVError} With 404 for a file that does not exist.
 */
async function proppatch(config, url, modTime) {
  const { response } = await send(config, "PROPPATCH", url, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
    body: PROPSET(secondsOf(modTime)),
  });
  if (response.status === 404) await failed(response);
  if (response.status !== 207) {
    await response.body?.cancel();
    return false;
  }
  try {
    const root = parseXML(await response.text());
    const statuses = childrenOf(root, "response")
      .flatMap((item) => childrenOf(item, "propstat"))
      .map((propstat) => textOf(propstat, "status"));
    return statuses.length > 0 &&
      statuses.every((status) => /^HTTP\/[\d.]+\s+2\d\d/.test(status));
  } catch {
    return false;
  }
}

/**
 * The whole seconds of a time, as `Unix` of Go.
 * @param {bigint} nanoseconds
 */
function secondsOf(nanoseconds) {
  const second = 1_000_000_000n;
  const seconds = nanoseconds / second;
  return nanoseconds < 0n && nanoseconds % second !== 0n
    ? seconds - 1n
    : seconds;
}

/**
 * Deletes a file, or a folder with all that is in it.
 * @param {Config} config
 * @param {URL} url
 */
async function remove(config, url) {
  const { response } = await send(config, "DELETE", url);
  if (response.status === 207) {
    // The server did not delete some of the files in the folder.
    let status = 500;
    try {
      const root = parseXML(await response.text());
      for (const item of childrenOf(root, "response")) {
        const match = textOf(item, "status").match(/^HTTP\/[\d.]+\s+(\d{3})/);
        if (match && !match[1].startsWith("2")) {
          status = Number(match[1]);
          break;
        }
      }
    } catch {
      // The status stays 500.
    }
    throw new WebDAVError("The server did not delete all the files", status);
  }
  if (!response.ok) await failed(response);
  await response.body?.cancel();
}

/**
 * Throws the error of an answer that is not 2xx, with the message of the
 * server, as `errorHandler` of rclone.
 * @param {Response} response
 * @returns {Promise<never>}
 */
async function failed(response) {
  const text = await response.text().catch(() => "");
  let message = "";
  try {
    const root = parseXML(text);
    message = [textOf(root, "message"), textOf(root, "exception")]
      .map((part) => part.trim()).filter(Boolean).join(": ");
  } catch {
    // The body is not XML.
  }
  if (!message && !/^\s*</.test(text)) message = text.trim().slice(0, 200);
  throw new WebDAVError(
    message || response.statusText || `status ${response.status}`,
    response.status,
  );
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
 * Sends a request to the server, with the headers of the configuration.
 *
 * As rclone, a redirect from HTTPS to HTTP is an error, and the
 * authentication and the headers of the option `headers` do not go to a
 * server on a different host, unless the option `auth_redirect` is `true`.
 * A redirect keeps the method. A redirect of an upload is an error: the body
 * cannot go two times.
 * @param {Config} config
 * @param {string} method
 * @param {URL} url
 * @param {{ headers?: Record<string, string>, body?: BodyInit }} [init]
 * @returns {Promise<{ response: Response, url: URL }>} The answer, and the
 *   URL of the answer after the redirects.
 * @throws {WebDAVError} When the server does not answer, or when a redirect
 *   is not permitted.
 */
async function send(config, method, url, { headers = {}, body } = {}) {
  const all = new Headers(config.headers);
  for (const [name, value] of Object.entries(headers)) all.set(name, value);
  // The size of a file is the size of the body that the client gets.
  if (!all.has("Accept-Encoding")) all.set("Accept-Encoding", "identity");
  /** @type {RequestInit} */
  const init = { method, headers: all, redirect: "manual" };
  if (body !== undefined) {
    init.body = body;
    if (body instanceof ReadableStream) init.duplex = "half";
  }

  const first = url;
  for (let redirects = 0;; redirects++) {
    let response;
    try {
      response = await fetch(url, init);
    } catch {
      throw new WebDAVError("The server did not answer", 502);
    }
    const location = response.headers.get("Location");
    if (!REDIRECTS.includes(response.status) || location === null) {
      return { response, url };
    }
    await response.body?.cancel();
    if (body instanceof ReadableStream) {
      throw new WebDAVError("The server sent a redirect for an upload", 502);
    }
    if (redirects === MAX_REDIRECTS) {
      throw new WebDAVError(`stopped after ${MAX_REDIRECTS} redirects`, 502);
    }
    const next = new URL(location, url);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new WebDAVError("A redirect to a URL that is not HTTP", 502);
    }
    if (
      url.protocol === "https:" && next.protocol === "http:" &&
      !config.authRedirect
    ) {
      throw new WebDAVError(
        "A redirect from HTTPS to HTTP is not permitted",
        502,
      );
    }
    if (!sameHost(next, first) && !config.authRedirect) {
      for (const name of config.secrets) all.delete(name);
    }
    url = next;
  }
}

/**
 * Tells if two URLs have the same host and port.
 * @param {URL} a
 * @param {URL} b
 */
function sameHost(a, b) {
  const port = (url) =>
    url.port || { "http:": "80", "https:": "443" }[url.protocol];
  return a.hostname === b.hostname && port(a) === port(b);
}

/**
 * Decodes each name of the path of a URL, for a comparison of two paths.
 * @param {string} pathname
 * @returns {string | null} null when a name has bad percent-encoding.
 */
function decodeNames(pathname) {
  try {
    return pathname.split("/").map((name) => {
      const decoded = decodeURIComponent(name);
      // A name with a "/" cannot be a name of rfetch.
      return decoded.includes("/") ? "\0" : decoded;
    }).join("/");
  } catch {
    return null;
  }
}

/**
 * Encodes a text in base64, from its bytes in UTF-8, as Go does for Basic
 * authentication.
 * @param {string} text
 */
function base64(text) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export default {
  fetch: webdav,
};
