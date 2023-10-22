import { auth } from "./auth.js";
import { list } from "./list.ts";
import { create } from "./create.ts";

import { File } from "./File.ts";

const FOLDER_TYPE = "application/vnd.google-apps.folder";

async function router(request: Request): Promise<Response> {
  //#region Auth
  const response = await auth(request);
  if (!response.ok) {
    return response;
  }

  const {
    access_token,
    token_type,
  } = await response.json();

  const Authorization = `${token_type} ${access_token}`;

  // "Upgrade" request to authorized request.
  request.headers.set("Authorization", Authorization);
  //#endregion Auth

  const headers = new Headers();
  let status = 200, body = null;

  const { method, url } = request;
  let { pathname, searchParams } = new URL(url);

  pathname = decodeURIComponent(pathname);
  const isDirectory = pathname.endsWith("/");

  const driveId = searchParams.get("team_drive") || "";
  const rootFolderId = searchParams.get("root_folder_id");
  let parentId = rootFolderId || driveId;

  // Retrives the parent folder's ID , relative to `team_drive` search params.
  // We will need this folder's ID for most operations.
  // TODO: Cache this result.
  searchParams.delete("root_folder_id"); // We want all files.
  const folders: File[] = await list(`/?${searchParams}`, {
    headers: {
      Authorization,
      "Content-Type": FOLDER_TYPE,
    },
  }).then((response) => response.json());

  parentId = getId(pathname, folders, parentId);

  if (method === "HEAD" || method === "GET") {
    // Retrieves file or folder info.
    searchParams.set("root_folder_id", parentId);
    const files: File[] = await list(`/?${searchParams}`, {
      headers: {
        Authorization,
        "Content-Type": request.headers.get("Content-Type") || "",
      },
    }).then((response) => response.json());

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
    if (isDirectory) {
      request.headers.set("Content-Type", FOLDER_TYPE);
    }

    return create(request);
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
 * Retrieves the ID of the file or folder for the given `pathname`.
 * @param pathname Relative path to find ID for.
 * @param files List of all files.
 * @param parentId The starting parent ID.
 * @returns The ID of the file or folder for that `pathname`.
 */
function getId(pathname: string, files: File[], parentId = "1") {
  const segments = pathname.split("/").filter((d) => d);

  for (const segment of segments) {
    const file = files.find((f) =>
      f.name === segment && f.parents[0] === parentId
    );
    if (!file) {
      return "";
    }
    parentId = file.id;
  }

  return parentId;
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
