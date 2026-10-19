/**
 * SFTP backend
 *
 * The sftp backend reads and writes the files of an SFTP server, as the
 * sftp backend of rclone. Its client of SSH is in JavaScript, on WebCrypto
 * and `node:net`, thus it runs in Node.js, Deno, Bun and workerd.
 *
 * A path is from the login folder of the user, as in rclone, for example
 * `:sftp,host=example.com:docs/a.txt`. A path that starts with `/` is from
 * the root of the server, for example `:sftp,host=example.com:/srv/a.txt`.
 * The fetch of rfetch tells this to the backend with `RFETCH_SFTP_ROOT` of
 * `env`.
 *
 * The options, with the names of rclone:
 *
 * - `host`, `port` (22 by default) and `user` (by default the user of the
 *   system, when there is one).
 * - `pass`: the password, obscured as in rclone. The backend tries it with
 *   `password`, then with `keyboard-interactive`.
 * - `key_pem`: a private key in PEM, with `\n` in place of the line breaks,
 *   or `key_file`: the location of such a file, which the backend reads with
 *   the fetch of rfetch. The key can be of OpenSSH, of PKCS #8, of PKCS #1
 *   or of SEC 1, for Ed25519, ECDSA or RSA. A key with a passphrase gives
 *   501.
 * - `host_keys`: the host keys of the server, as `algorithm base64` with
 *   `,` between them, as in a file `known_hosts`. The server must have one
 *   of them.
 * - `known_hosts_file`: the location of a file `known_hosts` of OpenSSH.
 *   The file must have the host key of the server. `none` is no check.
 * - `set_modtime`: `true` by default. Then a `PUT`, a `MOVE` and a `PATCH`
 *   with `X-OC-Mtime` set the time of the file, to the second.
 * - `skip_links`: with `true`, a list has no symbolic link. Else a link is
 *   the file or the folder that it points to, as in rclone.
 * - `chunk_size` (32 KiB by default) and `concurrency` (64 by default):
 *   the size of each read and write, and the number of reads or writes at
 *   the same time.
 * - `copy_is_hardlink`: with `true`, a COPY makes a hard link, with the
 *   extension `hardlink@openssh.com`. Else a COPY gives 501, as rclone has
 *   no copy on the server.
 * - `ciphers`, `key_exchange`, `macs` and `host_key_algorithms`: the
 *   algorithms of SSH, with spaces between them.
 * - `idle_timeout`: the time that a connection waits for a next request,
 *   60 s by default.
 * - `encoding`: the names that change on the server, as rclone, by default
 *   `Slash,Ctl,Del,Dot`.
 *
 * Security: with no `host_keys` and no `known_hosts_file`, the backend
 * accepts each host key of the server, as rclone does. Then a server in the
 * middle can get the password. Set `host_keys` to the key of the server.
 *
 * The algorithms: the key exchanges `curve25519-sha256` and
 * `ecdh-sha2-nistp256`, `-nistp384` and `-nistp521`, the host keys
 * `ssh-ed25519`, ECDSA and RSA with SHA-2, the ciphers
 * `aes128-gcm@openssh.com`, `aes256-gcm@openssh.com` and AES-CTR with the
 * MACs HMAC-SHA2-256 and HMAC-SHA2-512, as WebCrypto has them. The strict
 * key exchange of OpenSSH protects against the Terrapin attack.
 *
 * rfetch has no ssh-agent, no certificate of user, no command on the
 * server, and no proxy: `key_use_agent`, `pubkey`, `pubkey_file`, `ssh`,
 * `server_command`, `socks_proxy`, `http_proxy`, `pin_host_key` and
 * `use_insecure_cipher` give 501. rfetch accepts the other options of
 * rclone, for example the commands of the hashes, but they do nothing.
 *
 * Other than GET, HEAD, PUT and DELETE, the backend knows `MOVE` of a file
 * or of a folder (a rename on the server, as rclone), `PATCH` with
 * `X-OC-Mtime`, and `COPY` with `copy_is_hardlink`.
 *
 * In Node.js, Deno and Bun, a connection stays open for the next requests
 * of the same remote, for `idle_timeout`. In workerd, each request has its
 * own connection, as a connection cannot go from a request to another.
 */
import { decodeName, encodeName, parseEncoding } from "@rfetch/lib/encoder";
import { renderListing } from "@rfetch/lib/listing";
import { mimeType } from "@rfetch/lib/mime";
import { reveal } from "@rfetch/lib/obscure";
import { isTrue, optionsOf } from "@rfetch/lib/options";
import { Parts } from "@rfetch/lib/parts";
import { decodePath } from "@rfetch/lib/path";
import { notSatisfiable, parseRange, partialHeaders } from "@rfetch/lib/range";
import { parseSize } from "@rfetch/lib/size";
import { sized } from "@rfetch/lib/sized";
import { modTimeOf } from "@rfetch/lib/time";
import { findHostKey } from "./knownhosts.js";
import { isDirectory, isLink, OPEN, SFTP, SFTPError, STATUS } from "./sftp.js";
import { CIPHERS, MACS } from "./ssh/cipher.js";
import { AuthenticationError, SSHClient } from "./ssh/client.js";
import { readKeyLine, readPrivateKey, toBase64 } from "./ssh/keys.js";
import { HOST_KEYS, KEX } from "./ssh/transport.js";

/**
 * The options of the backend, with their types, for example for the flag
 * `--sftp-host` of the command line.
 */
export const options = {
  string: [
    "host",
    "user",
    "port",
    "pass",
    "key_pem",
    "key_file",
    "key_file_pass",
    "pubkey",
    "pubkey_file",
    "known_hosts_file",
    "host_keys",
    "path_override",
    "encoding",
    "shell_type",
    "hashes",
    "md5sum_command",
    "sha1sum_command",
    "crc32sum_command",
    "sha256sum_command",
    "blake3sum_command",
    "xxh3sum_command",
    "xxh128sum_command",
    "subsystem",
    "server_command",
    "idle_timeout",
    "chunk_size",
    "concurrency",
    "connections",
    "set_env",
    "ciphers",
    "key_exchange",
    "macs",
    "host_key_algorithms",
    "ssh",
    "socks_proxy",
    "http_proxy",
  ],
  boolean: [
    "pin_host_key",
    "key_use_agent",
    "use_insecure_cipher",
    "disable_hashcheck",
    "ask_password",
    "set_modtime",
    "skip_links",
    "use_fstat",
    "disable_concurrent_reads",
    "disable_concurrent_writes",
    "copy_is_hardlink",
  ],
  default: {
    port: "22",
    subsystem: "sftp",
    set_modtime: "true",
    chunk_size: "32Ki",
    concurrency: "64",
    idle_timeout: "1m0s",
    encoding: "Slash,Ctl,Del,Dot",
  },
};

/**
 * The options that are secret. They are not in the links of a list, which a
 * browser can keep in its history and send to other sites.
 */
const SECRETS = ["user", "pass", "key_pem", "key_file_pass"];

/** The options of rclone that rfetch does not know, when they are set. */
const UNKNOWN = [
  "key_use_agent",
  "pubkey",
  "pubkey_file",
  "ssh",
  "server_command",
  "socks_proxy",
  "http_proxy",
  "pin_host_key",
  "use_insecure_cipher",
];

/** The time to connect to a server, in milliseconds. */
const CONNECT_TIMEOUT = 60000;

/** The number of files or folders that a DELETE of a folder deletes at once. */
const DELETE_CONCURRENCY = 16;

/**
 * The configuration of the requests.
 * @typedef {Object} Config
 * @property {string} host
 * @property {number} port
 * @property {string} user
 * @property {string | undefined} password
 * @property {import("./ssh/keys.js").PrivateKey | undefined} privateKey
 * @property {{ type: string, blob: Uint8Array }[]} hostKeys
 * @property {string | null} knownHosts The content of `known_hosts_file`,
 *   or null for no file.
 * @property {{ ciphers?: string[], macs?: string[], kex?: string[], hostKeyAlgorithms?: string[] }} algorithms
 * @property {string} subsystem
 * @property {boolean} absolute True for a path from the root of the server.
 * @property {number} encoding The mask of the encoding of the names.
 * @property {boolean} setModTime
 * @property {boolean} skipLinks
 * @property {boolean} copyIsHardlink
 * @property {number} chunkSize
 * @property {number} concurrency
 * @property {number} idleTimeout In milliseconds.
 * @property {string} key The key of the connection in the pool.
 */

/** An error with the status of the answer. */
class SFTPBackendError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Serves an SFTP remote.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_SFTP_*` or `RCLONE_SFTP_*`, and `RFETCH_SFTP_ROOT` of rfetch.
 * @returns {Promise<Response>}
 */
async function sftpBackend(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);

  let config;
  try {
    config = await configOf(optionsOf(request, "sftp", env), env);
  } catch (error) {
    await request.body?.cancel();
    if (error instanceof SFTPBackendError) {
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

  /** @type {Session} */
  let session;
  try {
    session = await acquire(config);
  } catch (error) {
    await request.body?.cancel().catch(() => {});
    return errorResponse(error);
  }
  // A GET of a file streams its body: the session goes back at its end.
  let streaming = false;
  try {
    const { sftp } = session;
    if (method === "GET" || method === "HEAD") {
      if (isFolder) {
        const query = new URLSearchParams(searchParams);
        for (const name of SECRETS) query.delete(name);
        return await getFolder(config, sftp, remote, method, `${query}`);
      }
      const response = await getFile(config, session, remote, path, request);
      streaming = response.body !== null;
      return response;
    }
    if (method === "PUT") {
      /** @type {Record<string, string>} */
      const headers = { "Content-Location": pathname };
      if (isFolder) {
        await request.body?.cancel();
        await mkdirAll(sftp, remote);
      } else {
        await putFile(config, sftp, remote, request);
        if (modTime !== null && config.setModTime) {
          await setTime(sftp, remote, modTime);
          headers["X-OC-Mtime"] = "accepted";
        }
      }
      return new Response(null, { status: 201, headers });
    }
    await request.body?.cancel();
    if (method === "DELETE") {
      await (isFolder ? removeFolder(sftp, remote) : sftp.remove(remote));
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH") {
      if (isFolder) return new Response(null, { status: 405 });
      if (modTime === null) {
        return new Response("X-OC-Mtime is missing", { status: 400 });
      }
      if (!config.setModTime) {
        return new Response("can't set modified time", { status: 501 });
      }
      await sftp.stat(remote);
      await setTime(sftp, remote, modTime);
      return new Response(null, {
        status: 204,
        headers: { "X-OC-Mtime": "accepted" },
      });
    }
    // COPY and MOVE.
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
    if (method === "COPY") {
      if (isFolder || !config.copyIsHardlink) {
        return new Response("can't copy on the server", { status: 501 });
      }
      return await copyFile(sftp, remote, destination);
    }
    return await move(config, sftp, remote, destination, isFolder, modTime);
  } catch (error) {
    await request.body?.cancel().catch(() => {});
    return errorResponse(error);
  } finally {
    if (!streaming) release(session);
  }
}

/**
 * The answer of an error.
 * @param {unknown} error
 * @returns {Response}
 */
function errorResponse(error) {
  if (error instanceof SFTPBackendError) {
    return new Response(error.message, { status: error.status });
  }
  if (error instanceof SFTPError) {
    const status = {
      [STATUS.NO_SUCH_FILE]: 404,
      [STATUS.PERMISSION_DENIED]: 403,
      [STATUS.OP_UNSUPPORTED]: 501,
    }[error.code] ?? 500;
    return new Response(error.message, { status });
  }
  if (error instanceof AuthenticationError) {
    return new Response(error.message, { status: 403 });
  }
  if (error instanceof Error) {
    // A server that does not answer, or that does not speak SSH.
    return new Response(error.message, { status: 502 });
  }
  throw error;
}

/**
 * Reads the options of a request, as `NewFs` of the sftp backend of rclone.
 * @param {URLSearchParams} values
 * @param {Record<string, unknown>} env
 * @returns {Promise<Config>}
 * @throws {SFTPBackendError} When an option is not correct.
 */
async function configOf(values, env) {
  /** @param {string} name */
  const get = (name) => values.get(name) ?? options.default[name] ?? "";
  for (const name of UNKNOWN) {
    const value = get(name);
    if (value && value !== "false") {
      throw new SFTPBackendError(
        `rfetch does not know the option ${name}`,
        501,
      );
    }
  }
  const host = get("host");
  if (!host) throw new SFTPBackendError("The host option is missing", 400);
  const port = Number(get("port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SFTPBackendError("The port option is not a port", 400);
  }
  const user = get("user") || await systemUser();
  if (!user) throw new SFTPBackendError("The user option is missing", 400);

  let password;
  const obscured = get("pass");
  if (obscured) {
    try {
      password = await (await reveal(obscured)).text();
    } catch {
      throw new SFTPBackendError("couldn't decrypt password", 400);
    }
  }

  let pem = get("key_pem").replaceAll("\\n", "\n");
  if (!pem && get("key_file")) pem = await readLocation(get("key_file"));
  let privateKey;
  if (pem) {
    try {
      privateKey = await readPrivateKey(pem);
    } catch (error) {
      const passphrase = /passphrase/.test(error.message);
      throw new SFTPBackendError(
        `The private key is not correct: ${error.message}`,
        passphrase ? 501 : 400,
      );
    }
  }
  if (password === undefined && !privateKey) {
    throw new SFTPBackendError("The pass, key_pem or key_file is missing", 400);
  }

  /** @type {{ type: string, blob: Uint8Array }[]} */
  const hostKeys = [];
  for (const line of get("host_keys").split(",")) {
    if (line.trim() === "") continue;
    try {
      hostKeys.push(readKeyLine(line));
    } catch {
      throw new SFTPBackendError(
        `The host key ${line.trim()} is not correct`,
        400,
      );
    }
  }
  const knownHostsFile = get("known_hosts_file");
  const knownHosts = knownHostsFile && knownHostsFile !== "none"
    ? await readLocation(knownHostsFile)
    : null;

  const algorithms = {
    ciphers: chooseAlgorithms(get("ciphers"), Object.keys(CIPHERS), "ciphers"),
    macs: chooseAlgorithms(get("macs"), Object.keys(MACS), "macs"),
    kex: chooseAlgorithms(
      get("key_exchange"),
      Object.keys(KEX),
      "key_exchange",
    ),
    hostKeyAlgorithms: chooseAlgorithms(
      get("host_key_algorithms"),
      HOST_KEYS,
      "host_key_algorithms",
    ),
  };

  let encoding;
  try {
    encoding = parseEncoding(get("encoding"));
  } catch (error) {
    throw new SFTPBackendError(error.message, 400);
  }
  let chunkSize;
  try {
    chunkSize = parseSize(get("chunk_size"));
  } catch {
    chunkSize = NaN;
  }
  if (!(chunkSize >= 1 && chunkSize <= 256 * 1024)) {
    throw new SFTPBackendError(
      "chunk_size must be from 1 byte to 256 KiB",
      400,
    );
  }
  const concurrency = Number(get("concurrency"));
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new SFTPBackendError("concurrency must be 1 or more", 400);
  }
  const idleTimeout = parseDuration(get("idle_timeout"));
  if (Number.isNaN(idleTimeout)) {
    throw new SFTPBackendError("idle_timeout is not a duration", 400);
  }

  const subsystem = get("subsystem") || "sftp";
  const absolute = env.RFETCH_SFTP_ROOT === "/";
  // The connections of the pool, by a hash of all that makes a connection.
  const key = await hash(JSON.stringify([
    host,
    port,
    user,
    password ?? null,
    pem,
    get("host_keys"),
    knownHosts,
    algorithms,
    subsystem,
  ]));
  return {
    host,
    port,
    user,
    password,
    privateKey,
    hostKeys,
    knownHosts,
    algorithms,
    subsystem,
    absolute,
    encoding,
    setModTime: isTrue(get("set_modtime")),
    skipLinks: isTrue(get("skip_links")),
    copyIsHardlink: isTrue(get("copy_is_hardlink")),
    chunkSize,
    concurrency,
    idleTimeout,
    key,
  };
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
 * Reads a file of an option, for example `key_file`, with the fetch of
 * rfetch: a local path in the command line, or a location of a remote.
 * @param {string} location `~/` is the home folder.
 * @returns {Promise<string>}
 * @throws {SFTPBackendError}
 */
async function readLocation(location) {
  if (location.startsWith("~/")) {
    try {
      const { homedir } = await import("node:os");
      location = `${homedir()}${location.slice(1)}`;
    } catch {
      // No home folder, for example in workerd.
    }
  }
  try {
    const response = await fetch(location);
    if (response.ok) return await response.text();
    await response.body?.cancel();
  } catch {
    // The error below.
  }
  throw new SFTPBackendError(`rfetch cannot read ${location}`, 400);
}

/**
 * The algorithms of an option, in the order of the option.
 * @param {string} value The names, with spaces between them.
 * @param {string[]} known The algorithms of rfetch.
 * @param {string} name The name of the option.
 * @returns {string[] | undefined} No list for no option.
 * @throws {SFTPBackendError} When rfetch knows none of them.
 */
function chooseAlgorithms(value, known, name) {
  const names = value.split(/[\s,]+/).filter(Boolean);
  if (names.length === 0) return undefined;
  const chosen = names.filter((algorithm) => known.includes(algorithm));
  if (chosen.length === 0) {
    throw new SFTPBackendError(
      `rfetch knows none of the ${name}: it knows ${known.join(" ")}`,
      501,
    );
  }
  return chosen;
}

/**
 * Reads a duration of Go, for example `1m0s` or `30s`.
 * @param {string} text
 * @returns {number} Milliseconds, or NaN.
 */
function parseDuration(text) {
  if (text === "0") return 0;
  const units = {
    ns: 1e-6,
    us: 1e-3,
    "µs": 1e-3,
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
  };
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== text) {
    return NaN;
  }
  return parts.reduce(
    (sum, [, number, unit]) => sum + Number(number) * units[unit],
    0,
  );
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
 * The path on the server of a path of a request: each name with the
 * encoding, from the login folder or from the root.
 * @param {Config} config
 * @param {string} path For example `/a/b.txt` or `/a/`.
 */
function remotePath(config, path) {
  const names = path.slice(1).replace(/\/$/, "");
  const encoded = names === ""
    ? ""
    : names.split("/").map((name) => encodeName(name, config.encoding))
      .join("/");
  if (config.absolute) return `/${encoded}`;
  return encoded === "" ? "." : encoded;
}

/**
 * A connection of SSH with a session of SFTP, which requests can share.
 * @typedef {Object} Session
 * @property {SSHClient} client
 * @property {SFTP} sftp
 * @property {number} users The requests that use the session.
 * @property {ReturnType<typeof setTimeout> | null} timer
 * @property {Config} config
 */

/**
 * The sessions of the pool, by the keys of their configurations. workerd
 * has no pool: a connection cannot go from a request to another.
 * @type {Map<string, Promise<Session>>}
 */
const pool = new Map();
const POOLED = globalThis.navigator?.userAgent !== "Cloudflare-Workers";

/**
 * Gives a session for a request: a session of the pool, or a new one.
 * @param {Config} config
 * @returns {Promise<Session>}
 */
async function acquire(config) {
  if (POOLED) {
    const pending = pool.get(config.key);
    if (pending) {
      const session = await pending.catch(() => null);
      if (session && !session.client.isClosed) {
        session.users++;
        if (session.timer) clearTimeout(session.timer);
        session.timer = null;
        session.client.setActive(true);
        return session;
      }
      if (pool.get(config.key) === pending) pool.delete(config.key);
    }
  }
  const pending = connect(config);
  if (POOLED) {
    pool.set(config.key, pending);
    pending.catch(() => {
      if (pool.get(config.key) === pending) pool.delete(config.key);
    });
  }
  return await pending;
}

/**
 * Opens a connection, and starts SFTP on it.
 * @param {Config} config
 * @returns {Promise<Session>}
 */
async function connect(config) {
  const client = await SSHClient.connect({
    host: config.host,
    port: config.port,
    username: config.user,
    password: config.password,
    privateKey: config.privateKey,
    hostKeyTypes: config.hostKeys.map((key) => key.type),
    algorithms: config.algorithms,
    timeout: CONNECT_TIMEOUT,
    checkHostKey: (key) => checkHostKey(config, key),
  });
  try {
    const sftp = await SFTP.start(await client.subsystem(config.subsystem));
    /** @type {Session} */
    const session = { client, sftp, users: 1, timer: null, config };
    // A connection that closes leaves the pool.
    client.closed.then(() => {
      for (const [key, pending] of pool) {
        pending.then((other) => {
          if (other === session && pool.get(key) === pending) pool.delete(key);
        }, () => {});
      }
    });
    return session;
  } catch (error) {
    await client.close();
    throw error;
  }
}

/**
 * Checks the host key of the server, with `host_keys` or with
 * `known_hosts_file`.
 * @param {Config} config
 * @param {import("./ssh/transport.js").HostKey} key
 * @returns {Promise<boolean>}
 * @throws {SFTPBackendError} When the server has another key.
 */
async function checkHostKey(config, key) {
  const line = `${key.type} ${toBase64(key.blob)}`;
  if (config.hostKeys.length) {
    const known = config.hostKeys.some((known) =>
      known.type === key.type && toBase64(known.blob) === toBase64(key.blob)
    );
    if (!known) {
      throw new SFTPBackendError(
        `The host key ${key.fingerprint} of the server is not in host_keys: ${line}`,
        502,
      );
    }
    return true;
  }
  if (config.knownHosts !== null) {
    const found = await findHostKey(
      config.knownHosts,
      config.host,
      config.port,
      key.blob,
    );
    if (found !== "known") {
      throw new SFTPBackendError(
        `The host key ${key.fingerprint} of the server is ${found} in known_hosts_file`,
        502,
      );
    }
  }
  // With no host_keys and no known_hosts_file, each key, as rclone.
  return true;
}

/**
 * Gives a session back after a request. In the pool, it waits for the
 * next request for `idle_timeout`, and does not keep the process running.
 * Else it closes.
 * @param {Session} session
 */
function release(session) {
  session.users--;
  if (session.users > 0) return;
  if (!POOLED || session.config.idleTimeout === 0) {
    close(session);
    return;
  }
  session.client.setActive(false);
  session.timer = setTimeout(() => close(session), session.config.idleTimeout);
  // @ts-ignore: the timer of Node.js does not keep the process running.
  session.timer.unref?.();
}

/** @param {Session} session */
function close(session) {
  for (const [key, pending] of pool) {
    pending.then((other) => {
      if (other === session && pool.get(key) === pending) pool.delete(key);
    }, () => {});
  }
  session.client.close().catch(() => {});
}

/**
 * The time of a file in ISO 8601, to the second: the list of a remote with
 * a precision of 1 s has no part of a second.
 * @param {number | undefined} seconds
 */
function isoTime(seconds) {
  if (seconds === undefined) return "";
  return new Date(seconds * 1000).toISOString().replace(/\.000Z$/, "Z");
}

/**
 * Sets the time of a file, to the second.
 * @param {SFTP} sftp
 * @param {string} path
 * @param {bigint} nanoseconds
 */
async function setTime(sftp, path, nanoseconds) {
  const seconds = Number(nanoseconds / 1_000_000_000n) -
    (nanoseconds < 0n && nanoseconds % 1_000_000_000n !== 0n ? 1 : 0);
  if (seconds < 0 || seconds > 0xffffffff) {
    throw new SFTPBackendError("SFTP cannot keep this time", 501);
  }
  await sftp.setstat(path, { atime: seconds, mtime: seconds });
}

/**
 * Gets the list of a folder, or only its headers for HEAD.
 * @param {Config} config
 * @param {SFTP} sftp
 * @param {string} path
 * @param {string} method
 * @param {string} query The query of each link.
 * @returns {Promise<Response>}
 */
async function getFolder(config, sftp, path, method, query) {
  const attrs = await sftp.stat(path);
  if (!isDirectory(attrs)) return new Response(null, { status: 404 });
  const headers = { "Content-Type": "text/html;charset=utf-8" };
  if (method === "HEAD") return new Response(null, { headers });
  const items = await sftp.readdir(path);
  /** @type {import("@rfetch/lib/listing").Entry[]} */
  const entries = [];
  await Promise.all(items.map(async ({ filename, attrs }) => {
    if (isLink(attrs)) {
      if (config.skipLinks) return;
      // A link is the file or the folder that it points to. A link to
      // nothing is not in the list.
      try {
        attrs = await sftp.stat(join(path, filename));
      } catch {
        return;
      }
    }
    const Name = decodeName(filename, config.encoding);
    const folder = isDirectory(attrs);
    entries.push({
      Name,
      IsDir: folder,
      Size: folder ? -1 : Number(attrs.size ?? 0),
      MimeType: folder ? "" : mimeType(Name),
      ModTime: isoTime(attrs.mtime),
    });
  }));
  entries.sort((a, b) => a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0);
  return new Response(renderListing(entries, { query }), { headers });
}

/**
 * Joins a folder of the server and a name.
 * @param {string} folder
 * @param {string} name
 */
function join(folder, name) {
  if (folder === ".") return name;
  return folder.endsWith("/") ? `${folder}${name}` : `${folder}/${name}`;
}

/**
 * Gets a file, or only its headers for HEAD, with the `Range` of the
 * request, as RFC 9110.
 * @param {Config} config
 * @param {Session} session
 * @param {string} remote
 * @param {string} path The path of the request.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function getFile(config, session, remote, path, request) {
  const { sftp } = session;
  const attrs = await sftp.stat(remote);
  if (isDirectory(attrs)) return new Response(null, { status: 404 });
  const size = Number(attrs.size ?? 0);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const headers = new Headers({
    "Content-Type": mimeType(name),
    "Accept-Ranges": "bytes",
  });
  if (attrs.mtime !== undefined) {
    headers.set("Last-Modified", new Date(attrs.mtime * 1000).toUTCString());
  }
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
  const handle = await sftp.open(remote, OPEN.READ);
  const body = readStream(config, sftp, handle, start, length, () => {
    release(session);
  });
  return new Response(sized(body, length), { status, headers });
}

/**
 * Reads bytes of an open file, with reads of `chunk_size` at the same time,
 * in their order.
 * @param {Config} config
 * @param {SFTP} sftp
 * @param {Uint8Array} handle
 * @param {number} start
 * @param {number} length
 * @param {() => void} done Runs one time, at the end of the stream.
 * @returns {ReadableStream<Uint8Array>}
 */
function readStream(config, sftp, handle, start, length, done) {
  const end = start + length;
  let offset = start;
  /** @type {{ offset: number, size: number, data: Promise<Uint8Array | null> }[]} */
  const queue = [];
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    // The reads that wait must end before the handle closes.
    await Promise.allSettled(queue.map((item) => item.data));
    await sftp.close(handle).catch(() => {});
    done();
  };
  /** @param {number} at @param {number} size */
  const read = (at, size) => {
    const data = sftp.read(handle, at, size);
    data.catch(() => {});
    return { offset: at, size, data };
  };
  const fill = () => {
    while (queue.length < config.concurrency && offset < end) {
      const size = Math.min(config.chunkSize, end - offset);
      queue.push(read(offset, size));
      offset += size;
    }
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        fill();
        const item = queue.shift();
        if (!item) {
          await finish();
          controller.close();
          return;
        }
        const data = await item.data;
        if (data === null || data.length === 0) {
          throw new Error("The file is shorter than its size");
        }
        // A server can give less than the size of a read: the rest is the
        // next read.
        if (data.length < item.size) {
          queue.unshift(
            read(item.offset + data.length, item.size - data.length),
          );
        }
        controller.enqueue(data);
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel() {
      await finish();
    },
  });
}

/**
 * Makes a folder and its parent folders, as `mkdir` of rclone. A folder
 * that exists is not an error.
 * @param {SFTP} sftp
 * @param {string} path
 */
async function mkdirAll(sftp, path) {
  if (path === "." || path === "/") return;
  try {
    const attrs = await sftp.stat(path);
    if (isDirectory(attrs)) return;
    throw new SFTPBackendError(`${path} is a file, not a folder`, 409);
  } catch (error) {
    if (!(error instanceof SFTPError && error.code === STATUS.NO_SUCH_FILE)) {
      throw error;
    }
  }
  const slash = path.lastIndexOf("/");
  if (slash > 0) await mkdirAll(sftp, path.slice(0, slash));
  try {
    await sftp.mkdir(path);
  } catch (error) {
    // Another request made the folder at the same time.
    const attrs = await sftp.stat(path).catch(() => null);
    if (!attrs || !isDirectory(attrs)) throw error;
  }
}

/**
 * The folder of a path of the server.
 * @param {string} path
 */
function parentOf(path) {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return ".";
  return slash === 0 ? "/" : path.slice(0, slash);
}

/**
 * Puts a file, after its folders, with writes of `chunk_size` at the same
 * time. A failed upload deletes the part of the file, as rclone.
 * @param {Config} config
 * @param {SFTP} sftp
 * @param {string} path
 * @param {Request} request
 */
async function putFile(config, sftp, path, request) {
  await mkdirAll(sftp, parentOf(path));
  const handle = await sftp.open(
    path,
    OPEN.WRITE | OPEN.CREAT | OPEN.TRUNC,
  );
  const parts = new Parts(
    request.body ?? new Blob([]).stream(),
    config.chunkSize,
  );
  /** @type {Set<Promise<void>>} */
  const writes = new Set();
  /** @type {unknown} */
  let failure = null;
  try {
    let offset = 0;
    for (let part = await parts.next(); part; part = await parts.next()) {
      const write = sftp.write(handle, offset, part);
      offset += part.length;
      const tracked = write.then(
        () => {
          writes.delete(tracked);
        },
        (error) => {
          writes.delete(tracked);
          failure ??= error;
        },
      );
      writes.add(tracked);
      if (writes.size >= config.concurrency) await Promise.race(writes);
      if (failure) throw failure;
    }
    await Promise.all(writes);
    if (failure) throw failure;
    await sftp.close(handle);
  } catch (error) {
    await Promise.allSettled(writes);
    await sftp.close(handle).catch(() => {});
    await sftp.remove(path).catch(() => {});
    throw error;
  }
}

/**
 * Deletes a folder and all that is in it. The root of the remote stays.
 * @param {SFTP} sftp
 * @param {string} path
 */
async function removeFolder(sftp, path) {
  const attrs = await sftp.stat(path);
  if (!isDirectory(attrs)) {
    throw new SFTPBackendError(`${path} is not a folder`, 404);
  }
  await removeContent(sftp, path);
  if (path !== "." && path !== "/") await sftp.rmdir(path);
}

/**
 * Deletes all that is in a folder: a link is deleted, not what it points
 * to.
 * @param {SFTP} sftp
 * @param {string} path
 */
async function removeContent(sftp, path) {
  const items = await sftp.readdir(path);
  for (let i = 0; i < items.length; i += DELETE_CONCURRENCY) {
    await Promise.all(
      items.slice(i, i + DELETE_CONCURRENCY).map(
        async ({ filename, attrs }) => {
          const child = join(path, filename);
          if (isDirectory(attrs) && !isLink(attrs)) {
            await removeContent(sftp, child);
            await sftp.rmdir(child);
          } else {
            await sftp.remove(child);
          }
        },
      ),
    );
  }
}

/**
 * Tells if a path exists on the server.
 * @param {SFTP} sftp
 * @param {string} path
 */
async function exists(sftp, path) {
  try {
    await sftp.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof SFTPError && error.code === STATUS.NO_SUCH_FILE) {
      return false;
    }
    throw error;
  }
}

/**
 * Copies a file with a hard link, as `copy_is_hardlink` of rclone.
 * @param {SFTP} sftp
 * @param {string} source
 * @param {string} target
 * @returns {Promise<Response>}
 */
async function copyFile(sftp, source, target) {
  const attrs = await sftp.stat(source);
  if (isDirectory(attrs)) return new Response(null, { status: 404 });
  await mkdirAll(sftp, parentOf(target));
  const existed = await exists(sftp, target);
  if (existed) await sftp.remove(target);
  await sftp.hardlink(source, target);
  return new Response(null, { status: existed ? 204 : 201 });
}

/**
 * Moves a file, or a folder to a path that does not exist, with a rename on
 * the server, as rclone.
 * @param {Config} config
 * @param {SFTP} sftp
 * @param {string} source
 * @param {string} target
 * @param {boolean} isFolder
 * @param {bigint | null} modTime
 * @returns {Promise<Response>}
 */
async function move(config, sftp, source, target, isFolder, modTime) {
  const attrs = await sftp.stat(source);
  if (isDirectory(attrs) !== isFolder) {
    return new Response(null, { status: 404 });
  }
  const existed = await exists(sftp, target);
  if (isFolder && existed) {
    return new Response("Destination exists", { status: 412 });
  }
  await mkdirAll(sftp, parentOf(target));
  await sftp.rename(source, target, !isFolder);
  /** @type {Record<string, string>} */
  const headers = {};
  if (!isFolder && modTime !== null && config.setModTime) {
    await setTime(sftp, target, modTime);
    headers["X-OC-Mtime"] = "accepted";
  }
  return new Response(null, { status: existed ? 204 : 201, headers });
}

export default {
  fetch: sftpBackend,
};
