import { createHash, timingSafeEqual } from "node:crypto";
import { isOption, isTrue } from "@rfetch/lib/options";

import { listen } from "../listen.js";
import { handle, READ, WRITE } from "./handler.js";

/**
 * Serves a folder of a remote over WebDAV, as `rclone serve webdav`. The
 * path of a request is a path in the folder. Each request goes to the fetch
 * of rfetch, thus the remote gets all its options: the config file, the
 * variables of the environment, and the flags of the backend.
 *
 * A client reads and writes, as with rclone. With `--read-only`, it only
 * reads. With `--user` and `--pass`, a client must give them with the Basic
 * authentication. The default address is 127.0.0.1: with no `--user`, give
 * another address only on a network that you trust.
 *
 * A client sets no option of the remote: its query and its headers
 * `RFETCH_*` and `RCLONE_*` go away.
 * @param {string} remote The remote and the path of the folder, for example
 *   `remote:path/to/folder`.
 * @param {Object} [flags] `addr`, `user`, `pass`, `read_only`, and the flags
 *   of the backend.
 * @returns {Response} The lines of the server, for example the address.
 */
export function serve(remote, flags = {}) {
  const {
    addr = "127.0.0.1:8080",
    user = "",
    pass = "",
    read_only,
    "read-only": _,
    ...backendFlags
  } = flags;

  // The path of each request goes after the folder.
  const folder = /[:/]$/.test(remote) ? remote : `${remote}/`;
  const query = `${new URLSearchParams(backendFlags)}`;
  const readOnly = isTrue(read_only);
  /** @type {import("./handler.js").Server} */
  const server = {
    locate(pathname) {
      const path = `${folder}${pathname.slice(1)}`;
      return query ? `${path}?${query}` : path;
    },
    readOnly,
    query: "",
  };
  const login = user || pass ? digest(`${user}:${pass}`) : null;

  return listen(addr, readOnly ? READ : [...READ, ...WRITE], (request) => {
    if (login && !isLogin(request.headers.get("Authorization"), login)) {
      return Promise.resolve(
        new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="rfetch"' },
        }),
      );
    }
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!isOption(name)) headers.append(name, value);
    }
    return handle(new Request(request, { headers }), server);
  });
}

/** @param {string} text */
function digest(text) {
  return createHash("sha256").update(text).digest();
}

/**
 * Tells if the Basic authentication of a request has the user and the
 * password. The comparison takes the same time for each value.
 * @param {string | null} header The value of `Authorization`.
 * @param {Buffer} login The digest of `USER:PASS`.
 */
function isLogin(header, login) {
  const match = header?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!match) return false;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)),
    );
  } catch {
    return false;
  }
  return timingSafeEqual(digest(text), login);
}
