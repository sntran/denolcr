import { serve as serveHTTP } from "@sntran/serve";

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

  const abortController = new AbortController();

  const body = new ReadableStream({
    start(controller) {
      serveHTTP({
        fetch(request) {
          const url = new URL(request.url);
          Object.entries(backendFlags).forEach(([key, value]) => {
            if (!url.searchParams.has(key)) {
              url.searchParams.set(key, value);
            }
          });

          request = new Request(url, request);
          return fetch(request);
        },
        hostname,
        port: Number(port),
        signal: abortController.signal,
        onListen({ hostname, port }) {
          controller.enqueue(`Listening on http://${hostname}:${port}`);
        },
      });
    },
    cancel() {
      abortController.abort();
    },
  }).pipeThrough(new TextEncoderStream());

  return new Response(body);
}
