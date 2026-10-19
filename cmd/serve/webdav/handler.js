/**
 * A WebDAV server on the fetch of rfetch, as RFC 4918: the requests of a
 * WebDAV client become requests of the backend contract (GET, HEAD, PUT and
 * DELETE). `rfetch serve webdav` and the Worker use it.
 *
 * - PROPFIND reads the headers of HEAD, and the list of a folder for
 *   `Depth: 1`. `Depth: infinity` gets 403, as RFC 4918 permits: a list of
 *   all the files can be too large.
 * - MKCOL is PUT of a folder. COPY and MOVE read each file and put it at the
 *   destination, and MOVE deletes the source after.
 * - The server keeps no data between requests. Thus a LOCK gives a token
 *   and locks nothing, and PROPPATCH keeps no property, as
 *   `rclone serve webdav`. The clients of Windows and macOS need LOCK to
 *   write.
 */
import { readListing, relink } from "@rfetch/lib/listing";
import { mimeType } from "@rfetch/lib/mime";
import { isOption } from "@rfetch/lib/options";
import { decodePath } from "@rfetch/lib/path";
import { childrenOf, escapeXML, isXMLText, parseXML } from "@rfetch/lib/xml";

import { fetch } from "../../../fetch.js";

/** The methods of a client that reads. */
export const READ = ["OPTIONS", "GET", "HEAD", "PROPFIND"];

/** The methods of a client that writes. */
export const WRITE = [
  "PUT",
  "DELETE",
  "MKCOL",
  "COPY",
  "MOVE",
  "PROPPATCH",
  "LOCK",
  "UNLOCK",
];

/** The largest XML body of a request, in bytes. */
const MAX_XML = 1024 * 1024;

/** The status codes of the backends for a path that is not there. */
const MISSING = [404, 405, 409, 410];

/** The headers of one connection, which do not go to the remote. */
const HOP = [
  "connection",
  "expect",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** The time of a lock, in seconds. The server keeps no lock. */
const LOCK_SECONDS = 3600;

/** A name of XML with no prefix, for the properties of a client. */
const XML_NAME = /^[A-Za-z_][\w.-]*$/;

/** An answer to the client, as an error. */
class DAVError extends Error {
  /** @param {number} status @param {string} [message] @param {string} [xml] */
  constructor(status, message = "", xml = "") {
    super(message);
    this.status = status;
    this.xml = xml;
  }

  response() {
    if (this.xml) {
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?>\n` +
          `<D:error xmlns:D="DAV:">${this.xml}</D:error>`,
        {
          status: this.status,
          headers: { "Content-Type": "application/xml; charset=utf-8" },
        },
      );
    }
    return new Response(this.message || null, { status: this.status });
  }
}

/**
 * A server of the files of a remote.
 * @typedef {Object} Server
 * @property {(pathname: string) => string} locate The location for the
 *   fetch of rfetch of a path of the server, with its percent-encoding, for
 *   example `/a%20b.txt`. It throws a SyntaxError for a path with no remote.
 * @property {HeadersInit} [headers] The headers of each request to the
 *   remote, for example the options of a request of the Worker.
 * @property {boolean} [readOnly] When it is true, the server takes only the
 *   methods of `READ`.
 * @property {string} [query] When it is set, the links of a list get this
 *   query in the place of the options of the backend.
 * @property {(pathname: string) => string} [root] The root of the remote
 *   of a path of the server: the start of the path that is not a folder.
 *   It is `/` by default. The Worker has a remote in its paths, for example
 *   `/:memory:` for `/:memory:/a/b.txt`.
 * @property {(pathname: string) => string | null} [decode] Decodes a path
 *   of the server, and gives null for a path that is not safe: `decodePath`
 *   of `@rfetch/lib/path` by default. The Worker has remotes in its paths:
 *   it uses `decodeRemotePath`.
 */

/**
 * The information of a file or a folder.
 * @typedef {Object} Info
 * @property {string} name
 * @property {boolean} isDir
 * @property {number} size -1 when it is not known.
 * @property {string} type
 * @property {string} modTime The time in ISO 8601, or "".
 */

/**
 * Answers a request of a WebDAV client.
 * @param {Request} request
 * @param {Server} server
 * @returns {Promise<Response>}
 */
export async function handle(request, server) {
  const { method } = request;
  const { pathname } = new URL(request.url);
  const allowed = server.readOnly ? READ : [...READ, ...WRITE];
  if (!allowed.includes(method)) {
    await request.body?.cancel();
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: allowed.join(", ") },
    });
  }
  // The URL parser removes the names `.` and `..`, but a name such as
  // `..%2F..%2Fetc` must not go out of the folder.
  const decode = server.decode ?? decodePath;
  if (decode(pathname) === null) {
    await request.body?.cancel();
    return new Response("Bad Request", { status: 400 });
  }
  const target = pathname;

  try {
    switch (method) {
      case "OPTIONS":
        await request.body?.cancel();
        return new Response(null, {
          headers: {
            Allow: allowed.join(", "),
            DAV: "1, 2",
            "MS-Author-Via": "DAV",
          },
        });
      case "GET":
      case "HEAD":
      case "PUT":
        return await pass(request, server, target);
      case "DELETE":
        return await remove(request, server, target);
      case "PROPFIND":
        return await propfind(request, server, target);
      case "PROPPATCH":
        return await proppatch(request, server, target);
      case "MKCOL":
        return await mkcol(request, server, target);
      case "COPY":
      case "MOVE":
        return await copy(request, server, target);
      case "LOCK":
        return await lock(request, server, target);
      default: // UNLOCK
        await request.body?.cancel();
        if (!request.headers.get("Lock-Token")) {
          throw new DAVError(400, "UNLOCK needs a Lock-Token");
        }
        return new Response(null, { status: 204 });
    }
  } catch (error) {
    await request.body?.cancel().catch(() => {});
    if (error instanceof DAVError) return error.response();
    if (error instanceof SyntaxError) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }
}

/**
 * Sends a request to the remote, with the headers of the server.
 * @param {Server} server
 * @param {string} method
 * @param {string} pathname
 * @param {{ headers?: HeadersInit, body?: BodyInit | null }} [init]
 * @returns {Promise<Response>}
 */
function send(server, method, pathname, { headers = {}, body } = {}) {
  const all = new Headers(server.headers);
  for (const [name, value] of new Headers(headers)) all.set(name, value);
  /** @type {RequestInit} */
  const init = { method, headers: all };
  if (body !== undefined && body !== null) init.body = body;
  return fetch(server.locate(pathname), init);
}

/**
 * Sends GET, HEAD and PUT to the remote, with the headers of the client
 * that are not options: for example `Range`, `Content-Type` and
 * `Content-Length`.
 * @param {Request} request
 * @param {Server} server
 * @param {string} target
 * @returns {Promise<Response>}
 */
async function pass(request, server, target) {
  const { method } = request;
  if (method === "PUT" && target.endsWith("/")) {
    // A folder is not a file: MKCOL makes it.
    throw new DAVError(405, "PUT of a folder");
  }
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!isOption(name) && !HOP.includes(name)) headers.set(name, value);
  }
  const response = await send(server, method, target, {
    headers,
    body: method === "PUT" ? request.body : null,
  });
  if (method === "PUT") {
    await response.body?.cancel();
    return new Response(null, { status: response.ok ? 201 : response.status });
  }
  // The links of a list have the options of the backend in their query.
  const type = response.headers.get("Content-Type") || "";
  if (
    server.query !== undefined && response.ok && target.endsWith("/") &&
    type.startsWith("text/html")
  ) {
    return relink(response, server.query);
  }
  return response;
}

/**
 * Deletes a file, or a folder with all that is in it. A path with no `/` at
 * the end can be a folder: a client does not always put the `/`.
 * @param {Request} request
 * @param {Server} server
 * @param {string} target
 */
async function remove(request, server, target) {
  await request.body?.cancel();
  let response = await send(server, "DELETE", target);
  if (!target.endsWith("/") && MISSING.includes(response.status)) {
    await response.body?.cancel();
    response = await send(server, "DELETE", `${target}/`);
  }
  await response.body?.cancel();
  return new Response(null, {
    status: response.ok
      ? 204
      : MISSING.includes(response.status)
      ? 404
      : response.status,
  });
}

/**
 * Gives the information of a file or a folder, or null when it is not
 * there. A path with no `/` at the end can be a folder.
 * @param {Server} server
 * @param {string} target
 * @returns {Promise<Info & { href: string } | null>} `href` is the path,
 *   with a `/` at the end for a folder.
 */
async function stat(server, target) {
  const name = (server.decode ?? decodePath)(target)?.replace(/\/$/, "")
    .split("/").at(-1) ?? "";
  /** @type {Info & { href: string } | null} */
  let file = null;
  if (!target.endsWith("/")) {
    const response = await send(server, "HEAD", target);
    await response.body?.cancel();
    if (response.ok) {
      const { headers } = response;
      const length = headers.get("Content-Length") ?? "";
      file = {
        href: target,
        name,
        isDir: false,
        size: /^\d+$/.test(length) ? Number(length) : -1,
        type: headers.get("Content-Type") || mimeType(name),
        modTime: timeOf(headers.get("Last-Modified")),
      };
      // A file has a size. A backend can give the list of a folder for a
      // path with no "/", with no size, as the local backend.
      if (file.size >= 0) return file;
    } else if (!MISSING.includes(response.status)) {
      throw new DAVError(response.status);
    }
  }
  const folder = target.endsWith("/") ? target : `${target}/`;
  const response = await send(server, "HEAD", folder);
  await response.body?.cancel();
  if (!response.ok && file) return file;
  if (response.ok) {
    return {
      href: folder,
      name,
      isDir: true,
      size: -1,
      type: "",
      modTime: timeOf(response.headers.get("Last-Modified")),
    };
  }
  if (!MISSING.includes(response.status)) throw new DAVError(response.status);
  return null;
}

/**
 * Gives the entries of a folder.
 * @param {Server} server
 * @param {string} folder The path, with a `/` at the end.
 * @returns {Promise<import("@rfetch/lib/listing").Entry[]>}
 */
async function list(server, folder) {
  const response = await send(server, "GET", folder);
  if (!response.ok) {
    await response.body?.cancel();
    throw new DAVError(response.status);
  }
  return await readListing(response, new URL("http://server/folder/"));
}

/**
 * Reads a time of HTTP, to ISO 8601.
 * @param {string | null} text
 */
function timeOf(text) {
  const time = Date.parse(text ?? "");
  return isNaN(time) ? "" : new Date(time).toISOString();
}

/**
 * Reads the XML body of a request.
 * @param {Request} request
 * @returns {Promise<import("@rfetch/lib/xml").XMLElement | null>} null for
 *   no body.
 */
async function readXML(request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.length;
    if (size > MAX_XML) {
      await reader.cancel();
      throw new DAVError(413, "The XML body is too large");
    }
    chunks.push(read.value);
  }
  const text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
  if (text.trim() === "") return null;
  try {
    return parseXML(text);
  } catch (error) {
    throw new DAVError(400, `The body is not XML: ${error.message}`);
  }
}

/**
 * The properties of a client, from the elements of `prop`.
 * @param {import("@rfetch/lib/xml").XMLElement | undefined} prop
 * @returns {{ name: string, namespace: string }[]}
 */
function namesOf(prop) {
  return (prop?.children ?? [])
    .filter(({ name }) => XML_NAME.test(name))
    .map(({ name, namespace }) => ({ name, namespace }));
}

/**
 * Writes an element with no content, for a property of a client.
 * @param {{ name: string, namespace: string }} property
 */
function emptyElement({ name, namespace }) {
  if (namespace === "DAV:") return `<D:${name}/>`;
  return `<R:${name} xmlns:R="${escapeXML(namespace)}"/>`;
}

/**
 * The properties of WebDAV of a file or a folder, as XML.
 * @param {Info} info
 * @returns {Map<string, string>}
 */
function propertiesOf(info) {
  /** @type {Map<string, string>} */
  const properties = new Map();
  if (isXMLText(info.name)) properties.set("displayname", escapeXML(info.name));
  properties.set("resourcetype", info.isDir ? "<D:collection/>" : "");
  if (!info.isDir) {
    if (info.size >= 0) properties.set("getcontentlength", `${info.size}`);
    properties.set("getcontenttype", escapeXML(info.type));
  }
  if (info.modTime) {
    properties.set(
      "getlastmodified",
      new Date(info.modTime).toUTCString(),
    );
  }
  properties.set(
    "supportedlock",
    ["exclusive", "shared"].map((scope) =>
      `<D:lockentry><D:lockscope><D:${scope}/></D:lockscope>` +
      `<D:locktype><D:write/></D:locktype></D:lockentry>`
    ).join(""),
  );
  properties.set("lockdiscovery", "");
  return properties;
}

/**
 * Writes the `response` of a file or a folder in a multistatus.
 * @param {string} href
 * @param {Info} info
 * @param {"allprop" | "propname" | "prop"} mode
 * @param {{ name: string, namespace: string }[]} wanted
 */
function responseXML(href, info, mode, wanted) {
  const properties = propertiesOf(info);
  const propstat = (body, status) =>
    `<D:propstat><D:prop>${body}</D:prop>` +
    `<D:status>HTTP/1.1 ${status}</D:status></D:propstat>`;
  let body = "";
  if (mode === "propname") {
    body = propstat(
      [...properties.keys()].map((name) => `<D:${name}/>`).join(""),
      "200 OK",
    );
  } else if (mode === "allprop") {
    body = propstat(
      [...properties].map(([name, value]) => `<D:${name}>${value}</D:${name}>`)
        .join(""),
      "200 OK",
    );
  } else {
    const found = [];
    const missing = [];
    for (const property of wanted) {
      const value = property.namespace === "DAV:"
        ? properties.get(property.name)
        : undefined;
      if (value === undefined) {
        missing.push(emptyElement(property));
      } else {
        found.push(`<D:${property.name}>${value}</D:${property.name}>`);
      }
    }
    if (found.length) body += propstat(found.join(""), "200 OK");
    if (missing.length) body += propstat(missing.join(""), "404 Not Found");
  }
  return `<D:response><D:href>${escapeXML(href)}</D:href>${body}</D:response>`;
}

/**
 * Writes a multistatus answer.
 * @param {string} responses
 */
function multistatus(responses) {
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`,
    {
      status: 207,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    },
  );
}

/**
 * Answers PROPFIND with the properties of a file or a folder, and of the
 * entries of a folder for `Depth: 1`.
 * @param {Request} request
 * @param {Server} server
 * @param {string} target
 */
async function propfind(request, server, target) {
  const depth = request.headers.get("Depth") ?? "infinity";
  if (depth !== "0" && depth !== "1") {
    await request.body?.cancel();
    throw new DAVError(403, "", "<D:propfind-finite-depth/>");
  }
  const body = await readXML(request);
  /** @type {"allprop" | "propname" | "prop"} */
  let mode = "allprop";
  /** @type {{ name: string, namespace: string }[]} */
  let wanted = [];
  if (body) {
    if (body.name !== "propfind") {
      throw new DAVError(400, "The body is not a propfind");
    }
    const prop = childrenOf(body, "prop")[0];
    if (childrenOf(body, "propname").length) {
      mode = "propname";
    } else if (prop) {
      mode = "prop";
      wanted = namesOf(prop);
    }
  }

  const info = await stat(server, target);
  if (!info) throw new DAVError(404);
  let responses = responseXML(info.href, info, mode, wanted);
  if (depth === "1" && info.isDir) {
    for (const entry of await list(server, info.href)) {
      const href = `${info.href}${encodeURIComponent(entry.Name)}${
        entry.IsDir ? "/" : ""
      }`;
      responses += responseXML(
        href,
        {
          name: entry.Name,
          isDir: entry.IsDir,
          size: entry.IsDir ? -1 : entry.Size,
          type: entry.MimeType || mimeType(entry.Name),
          modTime: entry.ModTime,
        },
        mode,
        wanted,
      );
    }
  }
  return multistatus(responses);
}

/**
 * Answers PROPPATCH, as `rclone serve webdav`: each property gets 200, and
 * the server keeps none.
 * @param {Request} request
 * @param {Server} server
 * @param {string} target
 */
async function proppatch(request, server, target) {
  const body = await readXML(request);
  if (!body || body.name !== "propertyupdate") {
    throw new DAVError(400, "The body is not a propertyupdate");
  }
  const info = await stat(server, target);
  if (!info) throw new DAVError(404);
  const properties = [...childrenOf(body, "set"), ...childrenOf(body, "remove")]
    .flatMap((change) => childrenOf(change, "prop").flatMap(namesOf));
  return multistatus(
    `<D:response><D:href>${escapeXML(info.href)}</D:href>` +
      `<D:propstat><D:prop>${properties.map(emptyElement).join("")}</D:prop>` +
      `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
  );
}

/**
 * Tells if a path is the root of its remote.
 * @param {Server} server
 * @param {string} target
 */
function isRoot(server, target) {
  const root = server.root?.(target) ?? "/";
  return target.replace(/\/$/, "") === root.replace(/\/$/, "");
}

/**
 * The folder of a file or a folder, or null for the root of a remote.
 * @param {Server} server
 * @param {string} target
 * @returns {string | null}
 */
function parentOf(server, target) {
  if (isRoot(server, target)) return null;
  const root = server.root?.(target) ?? "/";
  const rest = target.slice(root.length).replace(/[^/]*\/?$/, "");
  return root.endsWith("/") || rest.startsWith("/")
    ? `${root}${rest}`
    : `${root}/${rest}`;
}

/**
 * Tells if the parent folder of a path exists.
 * @param {Server} server
 * @param {string} target
 */
async function hasParent(server, target) {
  const parent = parentOf(server, target);
  return parent !== null && await stat(server, parent) !== null;
}

/**
 * Answers MKCOL: a new folder in a folder that exists, as RFC 4918.
 * @param {Request} request
 * @param {Server} server
 * @param {string} target
 */
async function mkcol(request, server, target) {
  if (await hasBody(request)) {
    throw new DAVError(415, "MKCOL takes no body");
  }
  const folder = target.endsWith("/") ? target : `${target}/`;
  if (isRoot(server, folder) || await stat(server, target)) {
    throw new DAVError(405, "The path exists");
  }
  if (!await hasParent(server, folder)) {
    throw new DAVError(409, "The parent folder does not exist");
  }
  const response = await send(server, "PUT", folder);
  await response.body?.cancel();
  if (!response.ok) throw new DAVError(response.status);
  return new Response(null, { status: 201 });
}

/**
 * Tells if a request has a body with bytes, and reads it.
 * @param {Request} request
 */
async function hasBody(request) {
  if (!request.body) return false;
  const reader = request.body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    if (read.value.length > 0) {
      await reader.cancel();
      return true;
    }
  }
  return false;
}

/**
 * Answers COPY and MOVE. Each file goes through the server: the server
 * reads it from the source, and puts it at the destination.
 * @param {Request} request
 * @param {Server} server
 * @param {string} target
 */
async function copy(request, server, target) {
  await request.body?.cancel();
  const { method } = request;
  const url = new URL(request.url);
  const header = request.headers.get("Destination");
  if (!header) throw new DAVError(400, "No Destination");
  let destination;
  try {
    destination = new URL(header, url);
  } catch {
    throw new DAVError(400, "The Destination is not a URL");
  }
  if (destination.host !== url.host) {
    throw new DAVError(502, "The Destination is on another server");
  }
  const decode = server.decode ?? decodePath;
  const path = decode(destination.pathname);
  if (path === null) throw new DAVError(400, "The Destination is not safe");
  const overwrite = (request.headers.get("Overwrite") ?? "T").toUpperCase();
  if (overwrite !== "T" && overwrite !== "F") {
    throw new DAVError(400, "Overwrite is T or F");
  }
  const depth = request.headers.get("Depth") ?? "infinity";
  if (
    depth !== "infinity" && !(method === "COPY" && depth === "0")
  ) {
    throw new DAVError(400, `${method} with Depth ${depth}`);
  }

  const source = await stat(server, target);
  if (!source) throw new DAVError(404);
  const bare = destination.pathname.replace(/\/$/, "");
  const to = source.isDir ? `${bare}/` : bare;
  // The comparisons are of the paths with no percent-encoding: a client
  // can encode the same name in two ways.
  const from = decode(source.href) ?? "";
  const into = decode(to) ?? "";
  if (into === from || isRoot(server, to)) {
    throw new DAVError(403, "The destination cannot be the source or the root");
  }
  // A folder cannot go into itself, and the delete of a destination that
  // has the source in it deletes the source.
  if (
    (source.isDir && into.startsWith(from)) ||
    from.startsWith(into.endsWith("/") ? into : `${into}/`)
  ) {
    throw new DAVError(
      409,
      "The source and the destination are one in the other",
    );
  }
  if (!await hasParent(server, to)) {
    throw new DAVError(409, "The parent folder does not exist");
  }
  const existing = await stat(server, to.replace(/\/$/, ""));
  if (existing) {
    if (overwrite === "F") throw new DAVError(412, "The destination exists");
    await check(send(server, "DELETE", existing.href));
  }
  await copyTree(server, source.href, to, source.isDir, depth === "0");
  if (method === "MOVE") await check(send(server, "DELETE", source.href));
  return new Response(null, { status: existing ? 204 : 201 });
}

/**
 * Copies a file, or a folder with all that is in it.
 * @param {Server} server
 * @param {string} from
 * @param {string} to
 * @param {boolean} isDir
 * @param {boolean} [only] For a folder, copy only the folder.
 */
async function copyTree(server, from, to, isDir, only = false) {
  if (!isDir) {
    const response = await send(server, "GET", from);
    if (!response.ok) {
      await response.body?.cancel();
      throw new DAVError(response.status);
    }
    /** @type {Record<string, string>} */
    const headers = {};
    for (const name of ["Content-Type", "Content-Length"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    await check(send(server, "PUT", to, { headers, body: response.body }));
    return;
  }
  await check(send(server, "PUT", to));
  if (only) return;
  for (const entry of await list(server, from)) {
    const name = `${encodeURIComponent(entry.Name)}${entry.IsDir ? "/" : ""}`;
    await copyTree(server, `${from}${name}`, `${to}${name}`, entry.IsDir);
  }
}

/**
 * Waits for an answer of the remote, and throws its status when it is not
 * 2xx.
 * @param {Promise<Response>} request
 */
async function check(request) {
  const response = await request;
  await response.body?.cancel();
  if (!response.ok) throw new DAVError(response.status);
}

/**
 * Answers LOCK with a token, and locks nothing. A LOCK of a path that does
 * not exist makes an empty file, as RFC 4918. A LOCK with no body refreshes
 * the lock of the token in the header `If`.
 * @param {Request} request
 * @param {Server} server
 * @param {string} target
 */
async function lock(request, server, target) {
  const body = await readXML(request);
  let token;
  let scope = "exclusive";
  let owner = "";
  let created = false;
  if (body) {
    if (body.name !== "lockinfo") {
      throw new DAVError(400, "The body is not a lockinfo");
    }
    const kind = childrenOf(body, "lockscope")[0]?.children[0]?.name;
    if (kind === "shared") scope = "shared";
    const href = childrenOf(childrenOf(body, "owner")[0], "href")[0];
    const text = href?.text ?? childrenOf(body, "owner")[0]?.text ?? "";
    if (text.trim() && isXMLText(text)) {
      owner = href
        ? `<D:owner><D:href>${escapeXML(text.trim())}</D:href></D:owner>`
        : `<D:owner>${escapeXML(text.trim())}</D:owner>`;
    }
    token = `opaquelocktoken:${crypto.randomUUID()}`;
    if (!await stat(server, target)) {
      if (target.endsWith("/")) throw new DAVError(409, "No such folder");
      if (!await hasParent(server, target)) {
        throw new DAVError(409, "The parent folder does not exist");
      }
      await check(send(server, "PUT", target, {
        headers: { "Content-Length": "0" },
        body: new Uint8Array(0),
      }));
      created = true;
    }
  } else {
    token = request.headers.get("If")?.match(/<([^>]+)>/)?.[1];
    if (!token) throw new DAVError(400, "A refresh of a lock needs If");
  }
  const depth = request.headers.get("Depth") === "0" ? "0" : "infinity";
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
    `<D:locktype><D:write/></D:locktype>` +
    `<D:lockscope><D:${scope}/></D:lockscope>` +
    `<D:depth>${depth}</D:depth>${owner}` +
    `<D:timeout>Second-${LOCK_SECONDS}</D:timeout>` +
    `<D:locktoken><D:href>${escapeXML(token)}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${escapeXML(target)}</D:href></D:lockroot>` +
    `</D:activelock></D:lockdiscovery></D:prop>`;
  return new Response(xml, {
    status: created ? 201 : 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Lock-Token": `<${token}>`,
    },
  });
}
