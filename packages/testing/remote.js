import { readListing } from "@rfetch/lib/listing";

/** The origin of the URLs of the requests. A backend reads only the path. */
const ORIGIN = "http://rfetch.test";

/**
 * A client of a backend in the same process, for the tests. A path is plain
 * text, with `/` between the names and at the end of a folder. The client
 * puts the percent-encoding in each name, and the parameters of the backend
 * in the query.
 * @param {{ fetch: (request: Request, env?: object) => Response | Promise<Response> }} backend
 * @param {{ params?: Record<string, string>, root?: string, env?: object }} [options]
 *   `root` is a folder, for example `/rfetch-test-abc/`, under which all
 *   paths go. `env` is the env of the backend, for example the credentials of s3.
 */
export function remote(backend, { params = {}, root = "/", env = {} } = {}) {
  /**
   * Gives the URL of the path under the root.
   * @param {string} path
   * @returns {URL}
   */
  function url(path) {
    const encoded = `${root}${path}`.split("/").map(encodeURIComponent)
      .join("/");
    const url = new URL(encoded, ORIGIN);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    return url;
  }

  /**
   * Sends a request to the backend.
   * @param {string} path
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async function send(path, init = {}) {
    return await backend.fetch(
      new Request(url(path), { duplex: "half", ...init }),
      env,
    );
  }

  return {
    url,
    send,
    /** @param {string} path @param {BodyInit} [body] @param {HeadersInit} [headers] */
    put(path, body = new Uint8Array(0), headers = {}) {
      headers = new Headers(headers);
      // An HTTP client sends the size of a body that it knows.
      if (body instanceof Uint8Array && !headers.has("Content-Length")) {
        headers.set("Content-Length", `${body.length}`);
      }
      return send(path, { method: "PUT", body, headers });
    },
    /** @param {string} path @param {HeadersInit} [headers] */
    get: (path, headers = {}) => send(path, { headers }),
    /** @param {string} path */
    head: (path) => send(path, { method: "HEAD" }),
    /** @param {string} path */
    delete: (path) => send(path, { method: "DELETE" }),
    /**
     * Gives the entries of a folder, or throws with the status.
     * @param {string} path A folder, with `/` at the end, or "" for the root.
     */
    async list(path) {
      const response = await send(path);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`GET ${JSON.stringify(path)} gave ${response.status}`);
      }
      return await readListing(response, url(path));
    },
  };
}
