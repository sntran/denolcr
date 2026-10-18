import { createServer } from "node:http";
import { once } from "node:events";
import { relink } from "@rfetch/lib/listing";
import { isOption } from "@rfetch/lib/options";
import { decodePath } from "@rfetch/lib/path";

import { fetch } from "../../../fetch.js";

/** The methods of a client, as `rclone serve http`: it only reads. */
const METHODS = ["GET", "HEAD"];

/**
 * Serves a folder of a remote over HTTP, as `rclone serve http`. The path of
 * a request is a path in the folder. Each request goes to the fetch of
 * rfetch, thus the remote gets all its options: the config file, the
 * variables of the environment, and the flags of the backend, for example
 * `--crypt-password`.
 *
 * A client sets no option of the remote: its query and its headers
 * `RFETCH_*` and `RCLONE_*` go away. Else a client could change the remote,
 * for example `?remote=/etc/` for alias, or tell a new remote in the headers.
 * @param {string} remote The remote and the path of the folder, for example
 *   `remote:path/to/folder`.
 * @param {Object} [flags] `addr`, and the flags of the backend.
 * @returns {Response} The lines of the server, for example the address.
 */
export function serve(remote, flags = {}) {
  const {
    addr = "127.0.0.1:8080",
    ...backendFlags
  } = flags;

  let [hostname, port] = addr.split(":");
  if (!hostname) {
    hostname = "0.0.0.0";
  }

  // The path of each request goes after the folder.
  const folder = /[:/]$/.test(remote) ? remote : `${remote}/`;
  const query = `${new URLSearchParams(backendFlags)}`;

  /**
   * The answer to a request of a client.
   * @param {import("node:http").IncomingMessage} incoming
   * @param {AbortSignal} signal
   * @returns {Promise<Response>}
   */
  async function answer(incoming, signal) {
    // The check is before a Request: the Request of the Fetch standard
    // refuses TRACE. TRACE of the fetch of rfetch also tells the options of
    // the remote, with its secrets.
    if (!METHODS.includes(incoming.method ?? "")) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: METHODS.join(", ") },
      });
    }
    const { pathname } = new URL(incoming.url ?? "/", "http://localhost");
    // The URL parser removes the names `.` and `..`, but a name such as
    // `..%2F..%2Fetc` must not go out of the folder.
    if (decodePath(pathname) === null) {
      return new Response("Bad Request", { status: 400 });
    }
    const headers = new Headers();
    const { rawHeaders } = incoming;
    for (let i = 0; i < rawHeaders.length; i += 2) {
      if (!isOption(rawHeaders[i])) {
        headers.append(rawHeaders[i], rawHeaders[i + 1]);
      }
    }
    const path = `${folder}${pathname.slice(1)}`;
    const response = await fetch(query ? `${path}?${query}` : path, {
      method: incoming.method,
      headers,
      signal,
    });
    // The links of a list have the options of the backend in their query.
    // The server reads no query, thus the links of its lists have none.
    const type = response.headers.get("Content-Type") || "";
    if (response.ok && pathname.endsWith("/") && type.startsWith("text/html")) {
      return relink(response, "");
    }
    return response;
  }

  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    outgoing.once("close", () => controller.abort());
    /** @type {Response} */
    let response;
    try {
      response = await answer(incoming, controller.signal);
    } catch {
      // An error does not stop the server. Its message can tell the
      // config, thus the client does not get it.
      response = new Response("Internal Server Error", { status: 500 });
    }
    try {
      for (const [name, value] of response.headers) {
        if (name !== "set-cookie") outgoing.setHeader(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("Set-Cookie", cookies);
      outgoing.writeHead(response.status, response.statusText || undefined);
      if (incoming.method === "HEAD") {
        await response.body?.cancel();
      } else if (response.body) {
        for await (const chunk of response.body) {
          // Waits when the client reads slowly: else the file stays in memory.
          if (!outgoing.write(chunk)) await once(outgoing, "drain");
        }
      }
      outgoing.end();
    } catch {
      // The client went away.
      await response.body?.cancel().catch(() => {});
      outgoing.destroy();
    }
  });

  const body = new ReadableStream({
    start(controller) {
      server.on("error", (error) => controller.error(error));
      server.listen(Number(port), hostname, () => {
        const info = server.address();
        const where = typeof info === "string"
          ? info
          : `${info?.address}:${info?.port}`;
        controller.enqueue(`Listening on http://${where}\n`);
      });
    },
    cancel() {
      server.close();
      server.closeAllConnections?.();
    },
  }).pipeThrough(new TextEncoderStream());

  return new Response(body);
}
