import { serve as serveHTTP } from "@sntran/serve";
import { isOption } from "@rfetch/lib/options";

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
          // A client sets no option of the remote: its query and its
          // headers RFETCH_* and RCLONE_* go away. Else a client could
          // change the remote, for example `?remote=/etc/` for alias, or
          // tell a new remote in the headers.
          const url = new URL(request.url);
          url.search = "";
          for (const [key, value] of Object.entries(backendFlags)) {
            url.searchParams.set(key, value);
          }
          const headers = new Headers(request.headers);
          for (const key of [...headers.keys()]) {
            if (isOption(key)) headers.delete(key);
          }
          return fetch(new Request(new Request(url, request), { headers }));
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
