import { createServer } from "node:http";

/**
 * Converts Node's `IncomingMessage` to web `Request`.
 * @param {import("node:http").IncomingMessage} incoming
 * @returns {Request}
 */
function toWeb(incoming) {
  let { url, headers, method, body } = incoming;
  const abortController = new AbortController();
  headers = new Headers(headers);
  url = new URL(url, `http://${headers.get("Host")}`);

  incoming.once("aborted", () => abortController.abort());

  return new Request(url, {
    method,
    headers,
    body,
    signal: abortController.signal,
  });
}

/**
 * Serve the remote over HTTP.
 * @param {(Request) => Response | Promise<Response>} fetch
 * @returns {Response}
 */
export function serve(fetch, flags = {}) {
  const {
    addr = "127.0.0.1:8080",
    ...backendFlags
  } = flags;

  let [hostname, port] = addr.split(":");
  if (!hostname) {
    hostname = "0.0.0.0";
  }

  let server;
  const body = new ReadableStream({
    start(controller) {
      server = createServer(async (incoming, outgoing) => {
        let request = toWeb(incoming);
        const url = new URL(request.url);
        Object.entries(backendFlags).forEach(([key, value]) => {
          if (!url.searchParams.has(key)) {
            url.searchParams.set(key, value);
          }
        });

        request = new Request(url, request);
        const response = await fetch(request);

        const { status, statusText, headers, body } = response;
        headers.forEach((value, key) => outgoing.setHeader(key, value));
        outgoing.writeHead(status, statusText);

        if (body) {
          for await (const chunk of body) {
            outgoing.write(chunk);
          }
        }

        outgoing.end();
      });

      server.listen(Number(port), hostname, () => {
        controller.enqueue(`Listening on http://${hostname}:${port}`);
      });
    },
    async cancel() {
      await server.close();
    },
  }).pipeThrough(new TextEncoderStream());

  return new Response(body);
}
