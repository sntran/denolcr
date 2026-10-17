import { load } from "./backend/main.js";
// Sets the global `fetch` that reads the paths of remotes.
import "./mod.js";

/**
 * A handler
 *
 * @callback Handler
 * @param {Request} request
 * @param {Object} env Environment variables.
 * @returns {Response|Promise<Response>}
 */

/**
 * Serves a bare remote, i.e., `/:memory:/path/to/file`
 *
 * All configuration must be passed as query parameters.
 *
 * @param {Request} request
 * @param {Object} env
 * @param {Object} params
 * @param {string} params.remote
 * @param {string} [params.path]
 * @returns {Promise<Response}
 */
async function remote(request, env, params) {
  let { remote, path = "/" } = params;

  const backend = await load(remote);
  if (!backend) {
    return new Response("Remote not found.", { status: 404 });
  }

  if (!path) {
    path = "/";
  }

  const url = new URL(request.url);
  url.pathname = path;

  request = new Request(url, request);

  return backend.fetch(request, env);
}

const routes = {
  "/\\::remote\\:/": remote,
  "/\\::remote\\:/:path*": remote,
  "/\\::remote\\:/:path*/": (request, env, params) => {
    params.path += "/";
    return remote(request, env, params);
  },
};

/**
 * Routes request to the appropriate handler.
 * @param {Object} routes
 * @returns {Handler}
 */
function router(routes = {}) {
  return function (request, env) {
    const url = new URL(request.url);

    for (const [route, handler] of Object.entries(routes)) {
      const [pathname, method] = route.split("@").reverse();

      if (method && request.method !== method) continue;

      const pattern = new URLPattern({ pathname });
      if (!pattern.test(url)) continue;

      const params = pattern.exec(url)?.pathname?.groups || {};
      return handler(request, env, params);
    }

    return env.ASSETS.fetch(request);
  };
}

export default {
  fetch: router(routes),
};
