/**
 * FTP backend
 *
 * The ftp backend reads and writes the files of an FTP server, as the ftp
 * backend of rclone, also with TLS (FTPS). Its client of FTP is in
 * JavaScript, on `node:net` and `node:tls`, thus it runs in Node.js, Deno,
 * Bun and workerd.
 *
 * A path is from the login folder of the user, as in rclone, for example
 * `:ftp,host=example.com:docs/a.txt`. A path that starts with `/` is from
 * the root of the server, for example `:ftp,host=example.com:/pub/a.txt`.
 * The fetch of rfetch tells this to the backend with `RFETCH_FTP_ROOT` of
 * `env`.
 *
 * With no TLS, the password and the files go in clear on the network: use
 * `tls` or `explicit_tls` when the server has TLS.
 *
 * The options, with the names of rclone:
 *
 * - `host`, `port` (21 by default) and `user` (by default the user of the
 *   system, when there is one). For anonymous FTP, set `user=anonymous`.
 * - `pass`: the password, obscured as in rclone.
 * - `tls`: TLS from the start (implicit FTPS), usually on the port 990.
 * - `explicit_tls`: TLS after `AUTH TLS` (explicit FTPS). The client sends
 *   the user and the password only after TLS starts.
 * - `no_check_certificate`: no check of the certificate of the server. Then
 *   a server in the middle can get the password. workerd always checks the
 *   certificate: there, this option gives 501.
 * - `disable_tls13`: TLS 1.2 at most. In workerd, this option gives 501.
 * - `tls_cache_size`: 0 sends no TLS session of the control connection on
 *   the data connections. Other values send it, which many servers want.
 * - `concurrency`: the number of connections at the same time, 0 for no
 *   limit. A request waits for a free connection.
 * - `disable_epsv`, `disable_mlsd`, `disable_utf8` and `force_list_hidden`
 *   (`LIST -a` in place of MLSD).
 * - `writing_mdtm`: `MDTM` with a time sets the time of a file, as
 *   vsftpd. Else only a server with `MFMT` can set the time of a file.
 * - `idle_timeout`: the time that a connection waits for a next request,
 *   60 s by default, and 0 for no limit.
 * - `shut_timeout` and `close_timeout`: the time to wait for the answer of
 *   the server at the end of a transfer and of a download, 60 s by default.
 * - `no_check_upload`: no check of the size of a file after a `PUT`.
 * - `encoding`: the names that change on the server, as rclone, by default
 *   `Slash,Del,Ctl,RightSpace,Dot`. A CR or an LF in a name always changes,
 *   as in rclone: a name cannot add a command of FTP.
 *
 * rfetch has no proxy and asks for no password: `socks_proxy`, `http_proxy`
 * and `ask_password` give 501. `allow_insecure_tls_ciphers` does nothing:
 * the ciphers are the ciphers of the runtime.
 *
 * Other than GET, HEAD, PUT and DELETE, the backend knows `MOVE` of a file
 * or of a folder (a rename on the server, as rclone), and `PATCH` with
 * `X-OC-Mtime` on a server that can set the time of a file. FTP has no
 * copy on the server: a `COPY` gives 501.
 *
 * A list has the times of the files only with MLSD: the times of LIST are
 * not exact. A `GET` of a file gives `Last-Modified` with MLST or MDTM.
 * As rclone, a symbolic link is a file in a list.
 *
 * The data connections go to the host of the control connection, not to
 * the address in the answer of PASV: a server cannot send the client to
 * another host.
 *
 * Each connection does one transfer at a time. In Node.js, Deno and Bun, a
 * connection stays open for the next requests of the same remote, for
 * `idle_timeout`. In workerd, each request has its own connection, as a
 * connection cannot go from a request to another. There, a data connection
 * cannot use the TLS session of the control connection, as `node:tls` of
 * workerd does not resume sessions: a server that wants it refuses the
 * transfers from workerd.
 */
import {
  decodeName,
  EncodeCrLf,
  encodeName,
  parseEncoding,
} from "@rfetch/lib/encoder";
import { renderListing } from "@rfetch/lib/listing";
import { mimeType } from "@rfetch/lib/mime";
import { reveal } from "@rfetch/lib/obscure";
import { isTrue, optionsOf } from "@rfetch/lib/options";
import { decodePath } from "@rfetch/lib/path";
import { notSatisfiable, parseRange, partialHeaders } from "@rfetch/lib/range";
import { sized } from "@rfetch/lib/sized";
import { modTimeOf, parseDuration } from "@rfetch/lib/time";
import { FTPClient, FTPError } from "./client.js";
import { WORKERD } from "./socket.js";

/**
 * The options of the backend, with their types, for example for the flag
 * `--ftp-host` of the command line.
 */
export const options = {
  string: [
    "host",
    "user",
    "port",
    "pass",
    "concurrency",
    "idle_timeout",
    "close_timeout",
    "tls_cache_size",
    "shut_timeout",
    "socks_proxy",
    "http_proxy",
    "encoding",
  ],
  boolean: [
    "tls",
    "explicit_tls",
    "no_check_certificate",
    "disable_epsv",
    "disable_mlsd",
    "disable_utf8",
    "writing_mdtm",
    "force_list_hidden",
    "disable_tls13",
    "allow_insecure_tls_ciphers",
    "ask_password",
    "no_check_upload",
  ],
  default: {
    port: "21",
    concurrency: "0",
    idle_timeout: "1m0s",
    close_timeout: "1m0s",
    tls_cache_size: "32",
    shut_timeout: "1m0s",
    encoding: "Slash,Del,Ctl,RightSpace,Dot",
  },
};

/**
 * The options that are secret. They are not in the links of a list, which a
 * browser can keep in its history and send to other sites.
 */
const SECRETS = ["user", "pass"];

/** The options of rclone that rfetch does not know, when they are set. */
const UNKNOWN = ["socks_proxy", "http_proxy", "ask_password"];

/** The time to connect to a server, in milliseconds. */
const CONNECT_TIMEOUT = 60000;

/**
 * The configuration of the requests.
 * @typedef {Object} Config
 * @property {import("./client.js").ClientOptions} client The options of
 *   each connection.
 * @property {boolean} absolute True for a path from the root of the server.
 * @property {number} encoding The mask of the encoding of the names.
 * @property {number} concurrency The connections at the same time, 0 for
 *   no limit.
 * @property {number} idleTimeout In milliseconds, 0 for no limit.
 * @property {boolean} noCheckUpload
 * @property {string} key The key of the connections in the pool.
 */

/** An error with the status of the answer. */
class FTPBackendError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Serves an FTP remote.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_FTP_*` or `RCLONE_FTP_*`, and `RFETCH_FTP_ROOT` of rfetch.
 * @returns {Promise<Response>}
 */
async function ftpBackend(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);

  let config;
  try {
    config = await configOf(optionsOf(request, "ftp", env), env);
  } catch (error) {
    await request.body?.cancel();
    if (error instanceof FTPBackendError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
  const path = decodePath(pathname);
  if (path === null) {
    await request.body?.cancel();
    return new Response(null, { status: 400 });
  }
  const isFolder = path.endsWith("/");
  const modTime = modTimeOf(request);
  if (modTime === undefined) {
    await request.body?.cancel();
    return new Response("X-OC-Mtime is not a time", { status: 400 });
  }
  const remote = remotePath(config, path);

  if (
    !["GET", "HEAD", "PUT", "DELETE", "COPY", "MOVE", "PATCH"].includes(method)
  ) {
    await request.body?.cancel();
    return new Response(null, {
      status: 405,
      headers: { Allow: "GET, HEAD, PUT, DELETE, COPY, MOVE, PATCH" },
    });
  }
  if (method === "COPY") {
    await request.body?.cancel();
    return new Response("can't copy on the server", { status: 501 });
  }

  /** @type {FTPClient | null} */
  let client = null;
  // A GET of a file streams its body: the connection goes back at its end.
  let streaming = false;
  try {
    client = await acquire(config);
    if (method === "GET" || method === "HEAD") {
      if (isFolder) {
        const query = new URLSearchParams(searchParams);
        for (const name of SECRETS) query.delete(name);
        return await getFolder(config, client, remote, method, `${query}`);
      }
      const response = await getFile(config, client, remote, path, request);
      streaming = response.body !== null;
      return response;
    }
    if (method === "PUT") {
      /** @type {Record<string, string>} */
      const headers = { "Content-Location": pathname };
      if (isFolder) {
        await request.body?.cancel();
        await mkdirAll(client, remote);
        return new Response(null, { status: 201, headers });
      }
      await mkdirAll(client, parentOf(remote));
      let size;
      try {
        size = await client.store(
          remote,
          request.body ?? new Blob([]).stream(),
        );
      } catch (error) {
        await request.body?.cancel().catch(() => {});
        // A failed upload leaves a part of the file: it goes, as rclone.
        if (client.closed) {
          release(config, client);
          client = null;
          // The server can still write the part, as rclone says.
          await new Promise((resolve) => setTimeout(resolve, 1000));
          client = await acquire(config).catch(() => null);
        }
        await client?.command(`DELE ${remote}`).catch(() => {});
        throw error;
      }
      if (!config.noCheckUpload) {
        const item = await stat(client, remote);
        if (!item || (item.size >= 0 && item.size !== size)) {
          await client.command(`DELE ${remote}`).catch(() => {});
          throw new FTPBackendError(
            `The server has ${item?.size ?? "no"} bytes, not ${size}`,
            502,
          );
        }
      }
      if (modTime !== null && client.canSetTime) {
        await setTime(client, remote, modTime);
        headers["X-OC-Mtime"] = "accepted";
      }
      return new Response(null, { status: 201, headers });
    }
    await request.body?.cancel();
    if (method === "DELETE") {
      if (isFolder) await removeFolder(client, remote);
      else await client.command(`DELE ${remote}`);
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH") {
      if (isFolder) return new Response(null, { status: 405 });
      if (modTime === null) {
        return new Response("X-OC-Mtime is missing", { status: 400 });
      }
      if (!client.canSetTime) {
        return new Response("can't set modified time", { status: 501 });
      }
      const item = await stat(client, remote);
      if (!item || item.type === "dir") {
        return new Response(null, { status: 404 });
      }
      await setTime(client, remote, modTime);
      return new Response(null, {
        status: 204,
        headers: { "X-OC-Mtime": "accepted" },
      });
    }
    // MOVE.
    const target = decodePath(request.headers.get("Destination") ?? "");
    if (target === null || target === "/") {
      return new Response("Destination is not a path", { status: 400 });
    }
    if (target.endsWith("/") !== isFolder) {
      return new Response("Destination is not of the same type", {
        status: 409,
      });
    }
    const destination = remotePath(config, target);
    return await move(client, remote, destination, isFolder, modTime);
  } catch (error) {
    await request.body?.cancel().catch(() => {});
    return errorResponse(error);
  } finally {
    if (client && !streaming) release(config, client);
  }
}

/**
 * The answer of an error.
 * @param {unknown} error
 * @returns {Response}
 */
function errorResponse(error) {
  if (error instanceof FTPBackendError) {
    return new Response(error.message, { status: error.status });
  }
  if (error instanceof FTPError) {
    const status = {
      // The file is not available: it does not exist, or the user cannot
      // see it, as rclone.
      450: 404,
      550: 404,
      // Not signed in.
      530: 403,
      532: 403,
      // No space.
      452: 507,
      552: 507,
      // A name that the server does not take.
      553: 400,
      // A command that the server does not know.
      500: 501,
      502: 501,
      504: 501,
      // The server stops.
      421: 503,
    }[error.code] ?? 502;
    return new Response(error.message, { status });
  }
  if (error instanceof Error) {
    // A server that does not answer, or that does not speak FTP.
    return new Response(error.message, { status: 502 });
  }
  throw error;
}

/**
 * Reads the options of a request, as `NewFs` of the ftp backend of rclone.
 * @param {URLSearchParams} values
 * @param {Record<string, unknown>} env
 * @returns {Promise<Config>}
 * @throws {FTPBackendError} When an option is not correct.
 */
async function configOf(values, env) {
  /** @param {string} name */
  const get = (name) => values.get(name) ?? options.default[name] ?? "";
  for (const name of UNKNOWN) {
    const value = get(name);
    if (value && value !== "false") {
      throw new FTPBackendError(`rfetch does not know the option ${name}`, 501);
    }
  }
  const host = get("host");
  if (!host) throw new FTPBackendError("The host option is missing", 400);
  const port = Number(get("port") || "21");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new FTPBackendError("The port option is not a port", 400);
  }
  const user = get("user") || await systemUser();
  if (!user) throw new FTPBackendError("The user option is missing", 400);
  let password = "";
  const obscured = get("pass");
  if (obscured) {
    try {
      password = await (await reveal(obscured)).text();
    } catch {
      throw new FTPBackendError("couldn't decrypt password", 400);
    }
  }
  const tls = isTrue(get("tls"));
  const explicitTls = isTrue(get("explicit_tls"));
  if (tls && explicitTls) {
    throw new FTPBackendError(
      "implicit TLS and explicit TLS are mutually incompatible",
      400,
    );
  }
  const checkCertificate = !isTrue(get("no_check_certificate"));
  const disableTls13 = isTrue(get("disable_tls13"));
  if (WORKERD && (tls || explicitTls)) {
    if (!checkCertificate) {
      throw new FTPBackendError(
        "workerd always checks the certificate: no_check_certificate is not possible there",
        501,
      );
    }
    if (disableTls13) {
      throw new FTPBackendError(
        "workerd chooses the version of TLS: disable_tls13 is not possible there",
        501,
      );
    }
  }

  let encoding;
  try {
    encoding = parseEncoding(get("encoding"));
  } catch (error) {
    throw new FTPBackendError(error.message, 400);
  }
  /**
   * @param {string} name
   * @returns {number}
   */
  const count = (name) => {
    const value = Number(get(name));
    if (!Number.isInteger(value) || value < 0) {
      throw new FTPBackendError(`${name} must be 0 or more`, 400);
    }
    return value;
  };
  /**
   * @param {string} name
   * @returns {number}
   */
  const duration = (name) => {
    const value = parseDuration(get(name));
    if (Number.isNaN(value)) {
      throw new FTPBackendError(`${name} is not a duration`, 400);
    }
    return value;
  };

  /** @type {import("./client.js").ClientOptions} */
  const client = {
    host,
    port,
    user,
    password,
    tls,
    explicitTls,
    checkCertificate,
    disableTls13,
    tlsCache: count("tls_cache_size") > 0,
    disableEpsv: isTrue(get("disable_epsv")),
    disableMlsd: isTrue(get("disable_mlsd")),
    disableUtf8: isTrue(get("disable_utf8")),
    writingMdtm: isTrue(get("writing_mdtm")),
    forceListHidden: isTrue(get("force_list_hidden")),
    timeout: CONNECT_TIMEOUT,
    shutTimeout: duration("shut_timeout"),
    closeTimeout: duration("close_timeout"),
  };
  return {
    client,
    absolute: env.RFETCH_FTP_ROOT === "/",
    // A CR or an LF in a name could add a command, as rclone says.
    encoding: encoding | EncodeCrLf,
    concurrency: count("concurrency"),
    idleTimeout: duration("idle_timeout"),
    noCheckUpload: isTrue(get("no_check_upload")),
    // The connections of the pool, by a hash of all that makes a
    // connection.
    key: await hash(JSON.stringify(client)),
  };
}

/**
 * The SHA-256 of a text, in hexadecimal.
 * @param {string} text
 */
async function hash(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The user of the system, as the default user of rclone.
 * @returns {Promise<string>} "" when there is no such user, for example in
 *   workerd.
 */
async function systemUser() {
  try {
    const { userInfo } = await import("node:os");
    return userInfo().username;
  } catch {
    return "";
  }
}

/**
 * The path on the server of a path of a request: each name with the
 * encoding, from the login folder or from the root.
 * @param {Config} config
 * @param {string} path For example `/a/b.txt` or `/a/`.
 * @returns {string} "" is the login folder, and "/" the root.
 */
function remotePath(config, path) {
  const names = path.slice(1).replace(/\/$/, "");
  const encoded = names === ""
    ? ""
    : names.split("/").map((name) => encodeName(name, config.encoding))
      .join("/");
  return config.absolute ? `/${encoded}` : encoded;
}

/**
 * Tells if a path of the server is the root of the remote.
 * @param {string} path
 */
function isRoot(path) {
  return path === "" || path === "/";
}

/**
 * The folder of a path of the server.
 * @param {string} path
 */
function parentOf(path) {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return "";
  return slash === 0 ? "/" : path.slice(0, slash);
}

/**
 * Joins a folder of the server and a name.
 * @param {string} folder
 * @param {string} name
 */
function join(folder, name) {
  if (folder === "") return name;
  return folder.endsWith("/") ? `${folder}${name}` : `${folder}/${name}`;
}

/**
 * The connections of a configuration.
 * @typedef {Object} Pool
 * @property {{ client: FTPClient, timer: ReturnType<typeof setTimeout> | null }[]} idle
 * @property {number} active The connections that requests use.
 * @property {(() => void)[]} waiting The requests that wait for a
 *   connection.
 */

/**
 * The connections, by the keys of their configurations. workerd keeps no
 * connection: a connection cannot go from a request to another.
 * @type {Map<string, Pool>}
 */
const pools = new Map();

/**
 * The pool of each connection that a request uses.
 * @type {WeakMap<FTPClient, Pool>}
 */
const owners = new WeakMap();

/**
 * Removes a pool with no connection and no request from the pools.
 * @param {string} key
 * @param {Pool} pool
 */
function forget(key, pool) {
  if (
    pool.active === 0 && pool.idle.length === 0 &&
    pool.waiting.length === 0 && pools.get(key) === pool
  ) {
    pools.delete(key);
  }
}

/**
 * Gives a connection for a request: a connection of the pool, or a new one.
 * With `concurrency`, the request waits for a free connection.
 * @param {Config} config
 * @returns {Promise<FTPClient>}
 */
async function acquire(config) {
  let pool = pools.get(config.key);
  if (!pool) {
    pool = { idle: [], active: 0, waiting: [] };
    pools.set(config.key, pool);
  }
  while (config.concurrency > 0 && pool.active >= config.concurrency) {
    await new Promise((resolve) => pool.waiting.push(() => resolve(undefined)));
  }
  pool.active++;
  for (let entry = pool.idle.pop(); entry; entry = pool.idle.pop()) {
    if (entry.timer) clearTimeout(entry.timer);
    if (!entry.client.closed) {
      entry.client.setActive(true);
      owners.set(entry.client, pool);
      return entry.client;
    }
    entry.client.close().catch(() => {});
  }
  try {
    const client = await FTPClient.connect(config.client);
    owners.set(client, pool);
    return client;
  } catch (error) {
    pool.active--;
    const next = pool.waiting.shift();
    if (next) next();
    else forget(config.key, pool);
    throw error;
  }
}

/**
 * Gives a connection back after a request. In the pool, it waits for the
 * next request for `idle_timeout`, and does not keep the process running.
 * Else it closes.
 * @param {Config} config
 * @param {FTPClient} client
 */
function release(config, client) {
  const pool = /** @type {Pool} */ (owners.get(client));
  owners.delete(client);
  pool.active--;
  const next = pool.waiting.shift();
  next?.();
  if (WORKERD || client.closed) {
    client.close().catch(() => {});
    if (!next) forget(config.key, pool);
    return;
  }
  client.setActive(false);
  /** @type {Pool["idle"][number]} */
  const entry = { client, timer: null };
  if (config.idleTimeout > 0) {
    entry.timer = setTimeout(() => {
      const index = pool.idle.indexOf(entry);
      if (index !== -1) pool.idle.splice(index, 1);
      client.close().catch(() => {});
      forget(config.key, pool);
    }, config.idleTimeout);
    // @ts-ignore: the timer of Node.js does not keep the process running.
    entry.timer.unref?.();
  }
  pool.idle.push(entry);
}

/**
 * The entry of a path: with MLST, or in the list of its folder, as rclone.
 * @param {FTPClient} client
 * @param {string} path
 * @returns {Promise<import("./list.js").Item | null>} null for a path that
 *   does not exist.
 */
async function stat(client, path) {
  if (isRoot(path)) return { name: path, type: "dir", size: -1, modTime: "" };
  if (client.mlst) return await client.stat(path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  try {
    const items = await client.list(parentOf(path));
    return items.find((item) => item.name === name) ?? null;
  } catch (error) {
    if (
      error instanceof FTPError && (error.code === 550 || error.code === 450)
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Sets the time of a file, to the second.
 * @param {FTPClient} client
 * @param {string} path
 * @param {bigint} nanoseconds
 */
async function setTime(client, path, nanoseconds) {
  const seconds = Number(nanoseconds / 1_000_000_000n) -
    (nanoseconds < 0n && nanoseconds % 1_000_000_000n !== 0n ? 1 : 0);
  const time = new Date(seconds * 1000);
  const year = time.getUTCFullYear();
  if (Number.isNaN(year) || year < 1000 || year > 9999) {
    throw new FTPBackendError("FTP cannot keep this time", 501);
  }
  await client.setModTime(path, time);
}

/**
 * Gets the list of a folder, or only its headers for HEAD.
 * @param {Config} config
 * @param {FTPClient} client
 * @param {string} path
 * @param {string} method
 * @param {string} query The query of each link.
 * @returns {Promise<Response>}
 */
async function getFolder(config, client, path, method, query) {
  const item = await stat(client, path);
  if (!item || item.type !== "dir") return new Response(null, { status: 404 });
  const headers = { "Content-Type": "text/html;charset=utf-8" };
  if (method === "HEAD") return new Response(null, { headers });
  /** @type {import("@rfetch/lib/listing").Entry[]} */
  const entries = (await client.list(path)).map((item) => {
    const Name = decodeName(item.name, config.encoding);
    // As rclone, a link is a file.
    const folder = item.type === "dir";
    return {
      Name,
      IsDir: folder,
      Size: folder ? -1 : item.size,
      MimeType: folder ? "" : mimeType(Name),
      ModTime: item.modTime,
    };
  });
  entries.sort((a, b) => a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0);
  return new Response(renderListing(entries, { query }), { headers });
}

/**
 * Gets a file, or only its headers for HEAD, with the `Range` of the
 * request, as RFC 9110.
 * @param {Config} config
 * @param {FTPClient} client
 * @param {string} remote
 * @param {string} path The path of the request.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function getFile(config, client, remote, path, request) {
  const item = await stat(client, remote);
  if (!item || item.type === "dir") return new Response(null, { status: 404 });
  let size = item.size;
  if (size < 0) size = await client.size(remote).catch(() => -1);
  let modTime = item.modTime;
  if (!modTime) modTime = await client.modTime(remote).catch(() => "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const headers = new Headers({ "Content-Type": mimeType(name) });
  if (modTime) headers.set("Last-Modified", new Date(modTime).toUTCString());
  if (size < 0) {
    // With no size, no range: the file goes to its end.
    if (request.method === "HEAD") return new Response(null, { headers });
    const body = await client.retrieve(remote, 0, Infinity, true);
    return new Response(onEnd(body, () => release(config, client)), {
      headers,
    });
  }
  headers.set("Accept-Ranges", "bytes");
  let range = null;
  if (request.method === "GET") {
    try {
      range = parseRange(request.headers.get("Range"), size);
    } catch {
      return notSatisfiable(size);
    }
  }
  const start = range?.start ?? 0;
  const length = range ? range.end - range.start + 1 : size;
  headers.set("Content-Length", `${length}`);
  if (range) {
    for (const [key, value] of Object.entries(partialHeaders(range, size))) {
      headers.set(key, value);
    }
  }
  const status = range ? 206 : 200;
  if (request.method === "HEAD" || length === 0) {
    return new Response(null, { status, headers });
  }
  const body = await client.retrieve(
    remote,
    start,
    length,
    start + length === size,
  );
  return new Response(
    sized(onEnd(body, () => release(config, client)), length),
    { status, headers },
  );
}

/**
 * Runs a function one time at the end of a stream: at its last byte, at an
 * error, or when its reader cancels it.
 * @param {ReadableStream<Uint8Array>} stream
 * @param {() => void} done
 * @returns {ReadableStream<Uint8Array>}
 */
function onEnd(stream, done) {
  const reader = stream.getReader();
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    done();
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          end();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        end();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      end();
    },
  });
}

/**
 * Makes a folder and its parent folders, as `mkdir` of rclone. A folder
 * that exists is not an error.
 * @param {FTPClient} client
 * @param {string} path
 */
async function mkdirAll(client, path) {
  if (isRoot(path)) return;
  const item = await stat(client, path);
  if (item) {
    if (item.type === "dir") return;
    throw new FTPBackendError(`${path} is a file, not a folder`, 409);
  }
  await mkdirAll(client, parentOf(path));
  try {
    await client.command(`MKD ${path}`);
  } catch (error) {
    // 550 and 521: the folder exists, maybe from another request at the
    // same time, as rclone.
    if (!(error instanceof FTPError && [550, 521].includes(error.code))) {
      throw error;
    }
  }
}

/**
 * Deletes a folder and all that is in it. The root of the remote stays.
 * @param {FTPClient} client
 * @param {string} path
 */
async function removeFolder(client, path) {
  const item = await stat(client, path);
  if (!item || item.type !== "dir") {
    throw new FTPBackendError(`${path} is not a folder`, 404);
  }
  await removeContent(client, path);
  if (!isRoot(path)) await client.command(`RMD ${path}`);
}

/**
 * Deletes all that is in a folder: a link is deleted, not what it points
 * to.
 * @param {FTPClient} client
 * @param {string} path
 */
async function removeContent(client, path) {
  for (const item of await client.list(path)) {
    const child = join(path, item.name);
    if (item.type === "dir") {
      await removeContent(client, child);
      await client.command(`RMD ${child}`);
    } else {
      await client.command(`DELE ${child}`);
    }
  }
}

/**
 * Renames a path on the server, with RNFR and RNTO.
 * @param {FTPClient} client
 * @param {string} source
 * @param {string} target
 */
async function rename(client, source, target) {
  await client.command(`RNFR ${source}`);
  await client.command(`RNTO ${target}`);
}

/**
 * Moves a file, or a folder to a path that does not exist, with a rename on
 * the server, as rclone.
 * @param {FTPClient} client
 * @param {string} source
 * @param {string} target
 * @param {boolean} isFolder
 * @param {bigint | null} modTime
 * @returns {Promise<Response>}
 */
async function move(client, source, target, isFolder, modTime) {
  const item = await stat(client, source);
  if (!item || (item.type === "dir") !== isFolder) {
    return new Response(null, { status: 404 });
  }
  const existing = await stat(client, target);
  if (existing && (isFolder || existing.type === "dir")) {
    return new Response(
      isFolder ? "Destination exists" : "Destination is a folder",
      { status: isFolder ? 412 : 409 },
    );
  }
  await mkdirAll(client, parentOf(target));
  try {
    await rename(client, source, target);
  } catch (error) {
    // Some servers do not rename to a file that exists.
    if (!(existing && error instanceof FTPError)) throw error;
    await client.command(`DELE ${target}`);
    await rename(client, source, target);
  }
  /** @type {Record<string, string>} */
  const headers = {};
  if (!isFolder && modTime !== null && client.canSetTime) {
    await setTime(client, target, modTime);
    headers["X-OC-Mtime"] = "accepted";
  }
  return new Response(null, { status: existing ? 204 : 201, headers });
}

export default {
  fetch: ftpBackend,
};
