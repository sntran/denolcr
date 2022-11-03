import {} from "../../deps.ts";
import { reveal } from "rclone/cmd/obscure/main.ts";

const TOKEN_URL = "https://www.googleapis.com/oauth2/v4/token";
const DRIVE_URL = "https://www.googleapis.com/drive/v3/files";
const FILE_ATTRS =
  "id, name, mimeType, size, modifiedTime, description, iconLink, thumbnailLink, imageMediaMetadata";
const FOLDER_TYPE = "application/vnd.google-apps.folder";

const CLIENT_ID = "202264815644.apps.googleusercontent.com";
const CLIENT_SECRET = await reveal(
  "eX8GpZTVx3vxMWVkuuBdDWmAUE6rGhTwVrvG9GhllYccSdj2-mvHVg",
).then((r) => r.text());
const scopes = [
  "https://www.googleapis.com/auth/drive",
];

type Token = {
  access_token: string;
  refresh_token: string;
  expiry: string;
};

async function router(request: Request) {
  let response = await authorize(request);
  if (!response.ok) {
    return response;
  }

  const {
    access_token,
    token_type,
  } = await response.json();

  // "Upgrade" request to authorized request.
  request = new Request(request, {
    headers: {
      Authorization: `${token_type} ${access_token}`,
    },
  });

  const { method, url } = request;
  let { pathname, searchParams } = new URL(url);

  pathname = decodeURIComponent(pathname);
  const dirname = pathname.substring(0, pathname.lastIndexOf("/") + 1);
  const isDirectory = pathname.endsWith("/");

  const headers = new Headers();
  let status = 200, body = null;

  if (method === "HEAD" || method === "GET") {
    // Retrieves file or folder info.
    response = await list(request);
    const result = await response.json();
    if (result.error) {
      const { error, code, message } = result;
      return Response.json({
        error,
        code,
        message,
      }, {
        status: code,
        statusText: message,
      });
    }

    const files: Record<string, string>[] = result.files;

    // For request to folder, the file name list is returned in the Link header.
    if (isDirectory) {
      for await (let { name, mimeType } of files) {
        if (mimeType === FOLDER_TYPE) { // Folder
          name += "/";
        }
        headers.append("Link", `<${encodeURIComponent(name)}>`);
      }
    } else {
      const file = files.find((file) => {
        return file.mimeType !== FOLDER_TYPE &&
          file.name ===
            decodeURIComponent(pathname).slice(1).split("/").at(-1);
      })!;

      headers.append("Content-Type", file.mimeType);
      headers.append("Content-Length", file.size);
      headers.append("Last-Modified", file.modifiedTime);
      headers.append("ETag", file.md5Checksum);
    }
  }

  if (method === "GET") {
    // Retrieves file content.
    body = new ReadableStream();
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
 * Authorizes a Request.
 *
 * The returned Request will have an Authorization header with a valid access token.
 */
async function authorize(request: Request): Promise<Response> {
  const { headers, url } = request;
  const authorization = headers.get("Authorization");
  if (authorization) {
    const [token_type, access_token] = authorization.split(" ");
    return Response.json({
      token_type,
      access_token,
    });
  }

  const { searchParams } = new URL(url);
  const { refresh_token }: Token = JSON.parse(
    searchParams.get("token") || "{}",
  );
  // const serviceAccountFile = searchParams.get("service_account_file");

  const tokenURL = searchParams.get("token_url") || TOKEN_URL;
  const client_id = searchParams.get("client_id") || CLIENT_ID;
  const client_secret = searchParams.get("client_secret") || CLIENT_SECRET;

  const response = await fetch(tokenURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id,
      client_secret,
      refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const {
    error,
    error_description,
    access_token,
    expires_in,
    scope,
    token_type,
  } = await response.json();

  if (error) {
    return Response.json({
      error,
      error_description,
    }, {
      status: 401,
    });
  }

  if (expires_in <= 0) {
    // @TODO: refresh token
    return new Response();
  }

  if (scope !== "https://www.googleapis.com/auth/drive") {
    // @TODO: throws error?
    return new Response();
  }

  return Response.json({
    token_type,
    access_token,
    scope,
    expires_in,
  });
}

async function list(request: Request): Promise<Response> {
  const { headers, url } = request;
  const { pathname, searchParams } = new URL(url);

  // Shared Drive or My Drive
  const driveId = searchParams.get("team_drive") || "";
  const folderId = searchParams.get("root_folder_id") || "root";

  const params = new URLSearchParams({
    corpora: driveId ? "drive" : "user",
    driveId,
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
    q: `'${folderId}' in parents and trashed = false`,
    fields: `files(${FILE_ATTRS})`,
  });

  return await fetch(`${DRIVE_URL}?${params}`, {
    headers,
  });
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
