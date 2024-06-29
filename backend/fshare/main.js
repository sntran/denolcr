#!/usr/bin/env -S deno serve --allow-all

import { formatBytes } from "../../deps.js";

const API_URL = "https://api.fshare.vn/api";
const APP_KEY = "dMnqMMZMUnN5YpvKENaEhdQQ5jxDqddt";

/**
 * @typedef {Object} ListParams
 * @property {number|string} pageIndex
 * @property {toggle} dirOnly
 * @property {number|string} limit
 */

/**
 * @typedef {"0"|string} linkcode
 */

/**
 * @typedef {0 | 1 | "0" | "1"} toggle
 */

/**
 * An FShare file.
 * @typedef {Object} File
 * @property {string} id
 * @property {linkcode} linkcode
 * @property {string} name
 * @property {toggle} secure
 * @property {toggle} public
 * @property {toggle} copied
 * @property {toggle} shared
 * @property {toggle} directlink
 * @property {toggle} type
 * @property {string} path
 * @property {string} [hash_index]
 * @property {string} [crc32]
 * @property {number} owner_id
 * @property {number} pid
 * @property {number} size
 * @property {string} [mimetype]
 * @property {string} description
 * @property {number} [created]
 * @property {number} lastdownload
 * @property {0} pwd
 * @property {number} [modified]
 */

/**
 * Serves an FShare remote
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function fshare(request) {
  const { method, url } = request;
  let { pathname, searchParams } = new URL(url);

  let response;
  const requestHeaders = new Headers(request.headers);
  const config = Object.fromEntries(searchParams);

  pathname = decodeURIComponent(pathname);
  const dirname = pathname.substring(0, pathname.lastIndexOf("/") + 1);
  const isDirectory = pathname.endsWith("/");

  const headers = new Headers();
  let status = 200, body = null;

  const linkcode = searchParams.get("linkcode") || "";
  searchParams.delete("linkcode");

  if (method === "HEAD" || method === "GET") {
    requestHeaders.set("Content-Type", "application/json; charset=utf-8");

    // Retrieves user's files or folders
    if (!linkcode) {
      const params = new URLSearchParams();
      // @TODO: support other params for `fileops/list`
      // params.set("dirOnly", "1");
      // params.set("pageIndex", "0");
      // params.set("limit", "60");
      params.set("path", dirname.slice(1, -1));

      const url = `${API_URL}/fileops/list?${params}`;
      // const url = `https://www.fshare.vn/api/v3/files?${params}`;
      response = await authFetch(url, {
        headers: requestHeaders,
      });
    } else {
      // Retrieves files from a public folder using linkcode.
      const url = `${API_URL}/fileops/getFolderList`;
      // const url = `https://www.fshare.vn/api/v3/files?${params}`;
      response = await authFetch(url, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          url: `https://www.fshare.vn/folder/${linkcode}`,
          token: searchParams.get("token"),
        }),
      });
    }

    if (!response.ok) {
      return response;
    }

    if (response.headers.has("Set-Cookie")) {
      headers.set("Set-Cookie", response.headers.get("Set-Cookie"));
    }

    /**
     * @type {File[]}
     */
    const files = await response.json();

    // For request to folder, the file name list is returned in the Link header.
    if (isDirectory) {
      for await (let { name, type } of files) {
        if (type === "0") { // Folder
          name += "/";
        }
        headers.append("Link", `<${encodeURI(name)}>`);
      }

      if (method === "GET") {
        body = new ReadableStream({
          start(controller) {
            controller.enqueue(`
            <table cellpadding="4">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Size</th>
                <th>Modified</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>📁</td>
                <td><a href="../?${searchParams}">Go up</a></td>
                <td>—</td>
                <td>—</td>
              </tr>
            `);

            for (const { name, type, size, modified, mimetype } of files) {
              let filePath = name;
              const isDirectory = type === "0";
              if (isDirectory) {
                filePath += "/";
              }
              controller.enqueue(`<tr>
                <td>${isDirectory ? "📁" : "📄"}</td>
                <td>
                  <a
                    href="${filePath}?${searchParams}"
                    type="${mimetype || ""}"
                  >${name}</a>
                </td>
                <td>
                  <data
                    value="${size}"
                  >${
                Number(size) ? formatBytes(Number(size), { locale: true }) : "—"
              }</data>
                </td>
                <td>
                  <time
                    datetime="${new Date(modified * 1000).toISOString()}"
                  >${new Date(modified * 1000).toLocaleString()}</time>
                </td>
              </tr>`);
            }

            controller.enqueue("</tbody></table>");
            controller.close();
          },
        }).pipeThrough(new TextEncoderStream());
      }

      headers.set("Content-Type", "text/html;charset=utf-8");
    } else {
      const file = files.find((file) => {
        return file.type === "1" &&
          file.name ===
            decodeURIComponent(pathname).slice(1).split("/").at(-1);
      });

      if (!file) {
        return new Response("Not Found", {
          status: 404,
        });
      }

      headers.append("Content-Type", file.mimetype);
      headers.append("Content-Length", `${file.size}`);
      headers.append(
        "Last-Modified",
        new Date(Number(file.modified) * 1000).toUTCString(),
      );
      headers.append("ETag", file.hash_index || file.crc32 || "");

      if (method === "GET") {
        const url = new URL(file.linkcode, "https://www.fshare.vn/file/");
        url.searchParams.set("token", searchParams.get("token"));
        url.searchParams.set("password", searchParams.get("password") || "");
        response = await download(config, url, {
          headers: requestHeaders,
        });
        body = response.body;
      }
    }
  }

  if (method === "PUT") {
    // Folder ending with trailing slash.
    if (pathname.endsWith("/")) {
      // Creates folder.
    } else {
      // Creates file.
    }

    status = 201;
    headers.append("Content-Location", pathname);
  }

  if (method === "DELETE") {
    status = 204;
  }

  return new Response(body, {
    status,
    headers,
  });
}

/**
 * Fetches a resource, authenticates if necessary.
 * @param {string | URL | Request} request
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function authFetch(request, init) {
  request = new Request(request, init);
  let response = await fetch(request);
  if (response.status === 200) { // FIXME: FShare API returns 201 for unauthorized request.
    return response;
  }

  response = await auth(request);
  if (!response.ok) {
    return response;
  }

  const cookies = response.headers.getSetCookie().join("; ");

  let headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.set("Cookie", cookies);

  request = new Request(request, {
    headers,
  });

  // Retry.
  response = await fetch(request);
  // Stores cookies in response.
  headers = new Headers(response.headers);
  headers.set("Set-Cookie", cookies);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Authenticates user and returns the token.
 *
 * Usage Example:
 *
 * ```js
 * import { auth } from "./main.js";
 * const response = await auth({user_email: "", password: ""});
 * await response.text();
 * ```
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function auth(request) {
  const authResponse = new Response("401 Unauthorized", {
    status: 401,
    statusText: "Unauthorized",
    headers: {
      "WWW-Authenticate": `Basic realm="Login", charset="UTF-8"`,
    },
  });

  const headers = request.headers;
  const authorization = headers.get("Authorization");
  if (!authorization) {
    return authResponse;
  }

  const [user_email, password] = atob(authorization.split(" ").pop()).split(
    ":",
    2,
  );

  if (!user_email || !password) {
    return authResponse;
  }

  const url = `https://api.fshare.vn/api/user/login`;
  /**
   * @type {RequestInit}
   */
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": headers.get("User-Agent") || "denolcr-K58W6U",
    },
    body: JSON.stringify({
      app_key: APP_KEY,
      user_email,
      password,
    }),
    credentials: "same-origin",
  };

  const response = await fetch(url, init);

  const { code, msg, token, session_id } = await response.json();
  if (!token) {
    return authResponse;
  }

  return new Response(token, {
    status: code,
    statusText: msg,
    headers: {
      "Set-Cookie": `session_id=${session_id}; token=${token}`,
    },
  });
}

/**
 * Downloads file directly from an Fshare link.
 *
 * Usage Example:
 *
 * ```js
 * import { download } from "./main.js";
 * const response = await download({user_email: "", password: ""}, url);
 * response.body.pipeTo(Deno.stdout);
 * ```
 *
 * @param {Record<string, string>} config
 * @param {string | URL} url
 * @param {RequestInit} [init={}]
 * @returns {Promise<Response>}
 */
export async function download(config, url, init = {}) {
  url = new URL(url, "https://www.fshare.vn/file/");

  if (url.host !== "fshare.vn" && url.host !== "www.fshare.vn") {
    return new Response(null, {
      status: 400,
    });
  }

  const {
    method = "POST",
    redirect = "follow",
  } = init;

  const headers = new Headers(init.headers);

  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", "rclone/backend/fshare");
  }

  let token = url.searchParams.get("token");
  if (!token || !headers.has("Cookie")) {
    const response = await auth(config);
    token = await response.text();
    headers.set("Cookie", response.headers.get("Cookie"));
  }

  const password = url.searchParams.get("password") || "";
  url.searchParams.delete("password");

  const response = await fetch(`${API_URL}/session/download`, {
    method,
    headers,
    body: JSON.stringify({
      url: url.href,
      token,
      password,
    }),
  });

  /**
   * @type {{code: number, msg: string, location: string}}
   */
  const { location } = await response.json();

  if (!location) {
    return new Response("401 Unauthorized", {
      status: 401,
      statusText: "Unauthorized",
      headers: {
        "WWW-Authenticate": `Basic realm="Login", charset="UTF-8"`,
      },
    });
  }

  if (redirect === "manual") {
    return Response.redirect(location, 307);
  }
  if (redirect === "error") {
    throw new Error(`Redirected to ${location}`);
  }

  return fetch(location);
}

export default {
  fetch: fshare,
};
