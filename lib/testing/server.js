import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Serves a backend over HTTP on 127.0.0.1, for the tests of a backend that
 * sends requests to a server.
 * @param {(request: Request) => Response | Promise<Response>} handler
 * @returns {Promise<{ url: URL, close: () => Promise<void> }>} `url` is the
 *   root of the server, for example `http://127.0.0.1:40000/`.
 */
export async function listen(handler) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const { method, headers } = incoming;
      const request = new Request(
        new URL(incoming.url, `http://${headers.host}`),
        {
          method,
          headers: Object.entries(headers).flatMap(([name, value]) =>
            [value].flat().map((value) => [name, value])
          ),
          body: method === "GET" || method === "HEAD"
            ? null
            : Readable.toWeb(incoming),
          duplex: "half",
        },
      );
      const response = await handler(request);
      outgoing.writeHead(
        response.status,
        response.statusText,
        [...response.headers].flat(),
      );
      if (response.body) {
        await pipeline(Readable.fromWeb(response.body), outgoing);
      } else {
        outgoing.end();
      }
    } catch (error) {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end(`${error}`);
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: new URL(`http://127.0.0.1:${port}/`),
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
