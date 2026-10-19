import { fetch } from "../../fetch.js";
import { load } from "../../backend/main.js";

/**
 * Serves a remote backend
 * @param {'http' | 'webdav'} protocol The protocol to serve.
 * @param {string} remote The remote and the path of the folder to serve, for
 *   example `remote:path/to/folder`.
 * @param {Object} flags
 * @returns {Promise<Response>}
 */
export async function serve(protocol, remote, flags = {}) {
  // The remote must have a backend of rfetch. TRACE gives the type of the
  // remote, and does not go to the backend.
  const response = await fetch(remote, { method: "TRACE" });
  await response.body?.cancel();
  const [, type] = response.headers.get("Via")?.match(/^(.*?)(\/.*)?$/) || [];
  if (!type || !await load(type)) {
    throw new Error(`Backend ${type} not found.`);
  }

  if (protocol === "http") {
    const { serve } = await import("./http/main.js");
    return serve(remote, flags);
  }
  if (protocol === "webdav") {
    const { serve } = await import("./webdav/main.js");
    return serve(remote, flags);
  }
  throw new Error(`rfetch does not serve ${protocol}.`);
}
