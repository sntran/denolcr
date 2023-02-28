import {} from "../../deps.ts";

const API_URL = "https://api.fshare.vn/api";
const FSHARE_APP_KEY = "L2S7R6ZMagggC5wWkQhX2+aDi467PPuftWUMRFSn";

export interface ListParams {
  pageIndex: number | string;
  dirOnly: toggle;
  limit: number | string;
}

export type linkcode = "0" | string;
export type toggle = 0 | 1 | "0" | "1";

export interface File {
  id: string;
  linkcode: linkcode;
  name: string;
  secure: toggle;
  public: toggle;
  copied: toggle;
  shared: toggle;
  directlink: toggle;
  type: toggle;
  path: string;
  hash_index?: string;
  crc32?: string;
  owner_id: number;
  pid: number;
  size: number;
  mimetype?: string;
  description: string;
  created?: number;
  lastdownload: number;
  pwd: 0;
  modified?: number;
}

const authResponse = new Response("401 Unauthorized", {
  status: 401,
  statusText: "Unauthorized",
  headers: {
    "WWW-Authenticate": `Basic realm="Login", charset="UTF-8"`,
  },
});

const CACHE = new Map();

async function router(request: Request) {
  const { method, url } = request;
  let { pathname, searchParams } = new URL(url);

  const config = Object.fromEntries(searchParams);
  let response = await auth(config);
  if (!response.ok) {
    return response;
  }

  searchParams.set("token", await response.text());

  pathname = decodeURIComponent(pathname);
  const dirname = pathname.substring(0, pathname.lastIndexOf("/") + 1);
  const isDirectory = pathname.endsWith("/");

  const headers = new Headers();
  let status = 200, body = null;

  // The response headers from login contain the session_id cookie.
  const requestHeaders = response.headers;

  const linkcode = searchParams.get("linkcode") || "";
  searchParams.delete("linkcode");

  if (method === "HEAD" || method === "GET") {
    requestHeaders.set("Content-Type", "application/json; charset=utf-8");

    // Retrieves user's file or folder
    if (!linkcode) {
      const params = new URLSearchParams();
      // @TODO: support other params for `fileops/list`
      // params.set("dirOnly", "1");
      // params.set("pageIndex", "0");
      // params.set("limit", "60");
      params.set("path", dirname.slice(1, -1));

      const url = `${API_URL}/fileops/list?${params}`;
      // const url = `https://www.fshare.vn/api/v3/files?${params}`;
      response = await fetch(url, {
        headers: requestHeaders,
      });

    } else {
      // Retrieves files from a public folder using linkcode.
      const url = `${API_URL}/fileops/getFolderList`;
      // const url = `https://www.fshare.vn/api/v3/files?${params}`;
      response = await fetch(url, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          url: `https://www.fshare.vn/folder/${linkcode}`,
          token: searchParams.get("token")!,
        }),
      });
    }

    const files: File[] = await response.json();

    // For request to folder, the file name list is returned in the Link header.
    if (isDirectory) {
      for await (let { name, type } of files) {
        if (type === "0") { // Folder
          name += "/";
        }
        headers.append("Link", `<${encodeURIComponent(name)}>`);
      }
    } else {
      const file = files.find((file) => {
        return file.type === "1" &&
          file.name ===
            decodeURIComponent(pathname).slice(1).split("/").at(-1);
      })!;

      headers.append("Content-Type", file.mimetype!);
      headers.append("Content-Length", `${file.size}`);
      headers.append(
        "Last-Modified",
        new Date(Number(file.modified) * 1000).toUTCString(),
      );
      headers.append("ETag", file.hash_index || file.crc32 || "");

      if (method === "GET") {
        const url = new URL(file.linkcode, "https://www.fshare.vn/file/");
        url.searchParams.set("token", searchParams.get("token")!);
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
 * Authenticates user and returns the token.
 *
 * Usage Example:
 *
 * ```ts
 * import { auth } from "./main.ts";
 * const response = await auth({user_email: "", password: ""});
 * await response.text();
 * ```
 */
async function auth(params: Record<string, string>): Promise<Response> {
  const { user_email, password, app_key = FSHARE_APP_KEY } = params;

  if (!user_email || !password) {
    return authResponse;
  }

  let response: Response = CACHE.get({ user_email, password });

  if (!response) {
    const url = `${API_URL}/user/login`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_key,
        user_email,
        password,
      }),
      credentials: "same-origin",
    };

    response = await fetch(url, init);

    const { code, msg, token, session_id } = await response.json();
    if (!token) {
      return authResponse;
    }

    response = new Response(token, {
      status: code,
      statusText: msg,
      headers: {
        "Cookie": `session_id=${session_id};`,
      },
    });

    CACHE.set({ user_email, password }, response);
  }

  return response;
}

/**
 * Downloads file directly from an Fshare link.
 *
 * Usage Example:
 *
 * ```ts
 * import { download } from "./main.ts";
 * const response = await download({user_email: "", password: ""}, url);
 * response.body.pipeTo(Deno.stdout);
 * ```
 */
async function download(
  config: Record<string, string>,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const {
    method = "POST",
    redirect = "follow",
  } = init;

  const headers = new Headers(init.headers);

  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", "rclone/backend/fshare");
  }

  url = new URL(url, "https://www.fshare.vn/file/");
  let token = url.searchParams.get("token");
  if (!token || !headers.has("Cookie")) {
    const response = await auth(config);
    token = await response.text();
    headers.set("Cookie", response.headers.get("Cookie")!);
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

  const { code, msg, location } = await response.json();

  if (!location) {
    return authResponse;
  }

  if (redirect === "manual") {
    return Response.redirect(location, 303);
  }
  if (redirect === "error") {
    throw new Error(`Redirected to ${location}`);
  }

  return fetch(location);
}

const exports = {
  fetch: router,
};

export {
  auth,
  download,
  // For Cloudflare Workers.
  exports as default,
  router as fetch,
};

// Learn more at https://deno.land/manual/examples/module_metadata#concepts
if (import.meta.main) {
  Deno.serve(router);
}
