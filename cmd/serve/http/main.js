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

  const [hostname, port] = addr.split(":");

  let server;
  const body = new ReadableStream({
    start(controller) {
      server = Deno.serve({
        port: Number(port),
        hostname,
        onListen({ port, hostname }) {
          controller.enqueue(`Listening on http://${hostname}:${port}`);
        },
      }, (request) => {
        const url = new URL(request.url);
        Object.entries(backendFlags).forEach(([key, value]) => {
          if (!url.searchParams.has(key)) {
            url.searchParams.set(key, value);
          }
        });

        request = new Request(url, request);

        return fetch(request);
      });
    },
    async cancel() {
      await server.shutdown();
    },
  }).pipeThrough(new TextEncoderStream());

  return new Response(body);
}
