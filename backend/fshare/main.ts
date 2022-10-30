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

const authResponse = new Response("401 Unauthorized", {
  status: 401,
  statusText: "Unauthorized",
  headers: {
    "WWW-Authenticate": `Basic realm="Login", charset="UTF-8"`,
  },
});

async function router(request: Request) {
  let response = await login(request);
  if (!response.ok) {
    return response;
  }

  const { method, url } = request;
  let { pathname, searchParams } = new URL(url);

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
    // Retrieves user's file or folder
    if (!linkcode) {
      const params = new URLSearchParams();
      // @TODO: support other params for `fileops/list`
      params.set("path", dirname.slice(1, -1));

      const url = `${API_URL}/fileops/list?${params}`;
      let response = await fetch(url, {
        headers: requestHeaders,
      });

      const files: Record<string, string>[] = await response.json();

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

        headers.append("Content-Type", file.mimetype);
        headers.append("Content-Length", file.size);
        headers.append(
          "Last-Modified",
          new Date(Number(file.modified) * 1000).toUTCString(),
        );
        headers.append("ETag", file.crc32);

        if (method === "GET") {
          const url = new URL(file.linkcode, "https://www.fshare.vn/file/");
          url.searchParams.set("token", searchParams.get("token")!);
          url.searchParams.set("password", searchParams.get("password") || "");
          response = await download(url, {
            headers: requestHeaders,
          });
          body = response.body;
        }
      }
    } else {
      // Retrieves files from a public folder using linkcode.
      searchParams.set("url", `https://www.fshare.vn/folder/${linkcode}`);
      response = await fetch(
        `${API_URL}/fileops/getFolderList?${searchParams}`,
        {
          headers: requestHeaders,
        },
      );
      body = await response.body;
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

async function login({ headers }: Request): Promise<Response> {
  const authorization = headers.get("Authorization");

  if (!authorization) {
    return authResponse;
  }

  const [, base64 = ""] = authorization.match(/^Basic\s+(.*)$/) || [];
  const [user_email, password] = atob(base64).split(":");

  const url = `${API_URL}/user/login`;
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify({
      app_key: FSHARE_APP_KEY,
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
      "Cookie": `session_id=${session_id};`,
    },
  });
}

async function download(
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  url = new URL(url, "https://www.fshare.vn/file/");
  const token = url.searchParams.get("token")!;
  const password = url.searchParams.get("password") || "";
  url.searchParams.delete("password");

  const {
    method = "POST",
    redirect = "follow",
  } = init;

  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", "rclone/backend/fshare");
  }

  const response = await fetch(`${API_URL}/session/download`, {
    method,
    headers,
    body: JSON.stringify({
      url: url.href,
      token,
      password,
    }),
  });

  const { location } = await response.json();

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
  // For Cloudflare Workers.
  exports as default,
  router as fetch,
};

// Learn more at https://deno.land/manual/examples/module_metadata#concepts
if (import.meta.main) {
  Deno.serve(router);
}
