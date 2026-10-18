import { fetch } from "../../fetch.js";
import { load } from "../../backend/main.js";

/**
 * Serves a remote backend
 * @param {'http'} protocol The protocol to serve.
 * @param {string} remote
 * @param {Object} flags
 * @returns {Response|Promise<Response>}
 */
export async function serve(protocol, remote, flags = {}) {
  // TRACE the remote to retrive its type and configuration.
  const response = await fetch(remote, { method: "TRACE" });
  const [, type] = response.headers.get("Via")?.match(/^(.*?)(\/.*)?$/) || [];
  const body = await response.text();
  const [, url] = body.match(/^TRACE (.*) HTTP\/1.1$/m) ||
    [];
  const { searchParams } = new URL(url, "file:");
  // Fills the options with the remote's configuration.
  // TODO: remove prefix from flags specific for the remote.
  searchParams.forEach((value, key) => {
    if (!flags[key]) {
      flags[key] = value;
    }
  });

  const backend = await load(type);
  if (!backend) {
    throw new Error(`Backend ${type} not found.`);
  }

  if (protocol === "http") {
    const { serve } = await import("./http/main.js");
    return serve(backend.fetch, flags);
  }
}
