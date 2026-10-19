import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";

/**
 * Serves the answers of a function over HTTP, for the commands `serve`.
 *
 * A request with a method that is not in `methods` gets 405, before a
 * Request: the Request of the Fetch standard refuses TRACE, and TRACE of
 * the fetch of rfetch tells the options of the remote. An error of `answer`
 * gives 500 and does not stop the server. Its message can tell the config,
 * thus the client does not get it.
 * @param {string} addr For example `127.0.0.1:8080`, or `:8080` for all the
 *   addresses.
 * @param {string[]} methods The methods of the clients.
 * @param {(request: Request) => Promise<Response>} answer
 * @returns {Response} The lines of the server, for example the address.
 *   The cancel of the body stops the server.
 */
export function listen(addr, methods, answer) {
  let [hostname, port] = addr.split(":");
  if (!hostname) {
    hostname = "0.0.0.0";
  }

  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    outgoing.once("close", () => controller.abort());
    /** @type {Response} */
    let response;
    try {
      response = methods.includes(incoming.method ?? "")
        ? await answer(requestOf(incoming, controller.signal))
        : new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: methods.join(", ") },
        });
    } catch {
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

/**
 * Makes the Request of a request of a client. A header that a Request
 * cannot have is not in it.
 * @param {import("node:http").IncomingMessage} incoming
 * @param {AbortSignal} signal
 * @returns {Request}
 */
function requestOf(incoming, signal) {
  const method = incoming.method ?? "GET";
  const headers = new Headers();
  const { rawHeaders } = incoming;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    try {
      headers.append(rawHeaders[i], rawHeaders[i + 1]);
    } catch {
      // A name or a value that is not correct for HTTP.
    }
  }
  let url;
  try {
    url = new URL(incoming.url ?? "/", `http://${incoming.headers.host}`);
  } catch {
    url = new URL(incoming.url ?? "/", "http://localhost");
  }
  const body = method === "GET" || method === "HEAD"
    ? null
    : /** @type {ReadableStream} */ (Readable.toWeb(incoming));
  return new Request(url, { method, headers, body, duplex: "half", signal });
}
