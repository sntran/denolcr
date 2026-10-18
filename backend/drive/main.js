import { formatBytes } from "@rfetch/lib/format";
import { optionsOf, remoteHeaders } from "@rfetch/lib/options";

import { auth } from "./auth.js";
import { list } from "./list.js";
import { create } from "./create.js";
import { fetch as fetchFile } from "./file.js";

const FOLDER_TYPE = "application/vnd.google-apps.folder";
// Set of headers that a file should have.
const FILE_HEADERS = new Headers({
  "Accept-Ranges": "bytes",
  "Content-Length": "0",
  "Content-Range": "bytes */0",
  "Content-Type": "application/octet-stream",
});

/**
 * The options that are secret. They are not in the links of a list.
 */
const SECRETS = ["token", "client_secret", "service_account_credentials"];

/**
 * Serves a Google Drive remote.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_DRIVE_*` or `RCLONE_DRIVE_*`.
 * @returns {Promise<Response>}
 */
async function drive(request, env = {}) {
  // The links of a list keep the query of the request, with no secret.
  const links = new URL(request.url).searchParams;
  for (const name of SECRETS) links.delete(name);
  // The parts of the backend read the options in the query. The options of
  // rclone do not go to Google.
  const target = new URL(request.url);
  target.search = `${optionsOf(request, "drive", env)}`;
  request = new Request(target, {
    method: request.method,
    headers: remoteHeaders(
      request.headers,
      "drive",
      "https://www.googleapis.com/",
    ),
    body: request.body,
    duplex: "half",
  });

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
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Authorization", Authorization);
  request = new Request(request, {
    headers: requestHeaders,
  });
  //#endregion Auth

  const headers = new Headers();
  let status = 200, body = null;

  const { method, url } = request;
  let { pathname } = new URL(url);

  pathname = decodeURIComponent(pathname);
  const isDirectory = pathname.endsWith("/");

  if (method === "PUT") {
    // TODO: Nested folder creation.
    if (isDirectory) {
      request.headers.set("Content-Type", FOLDER_TYPE);
    }

    return create(request);
  }

  /**
   * @type {import("./file.js").File[]}
   */
  let files = [];
  try {
    files = await list(request).then((r) => r.json());
  } catch (_error) {
    return new Response(null, {
      status: 404,
    });
  }

  if (method === "HEAD" || method === "GET") {
    // For request to folder, displays the folder content in HTML
    if (isDirectory) {
      for (const { name, mimeType } of files) {
        let filePath = name;
        const isDirectory = mimeType.includes("folder");
        if (isDirectory) {
          filePath += "/";
        }
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
                <td><a href="../?${links}">Go up</a></td>
                <td>—</td>
                <td>—</td>
              </tr>
            `);

            for (const { name, mimeType, size, modifiedTime } of files) {
              let filePath = name;
              const isDirectory = mimeType.includes("folder");
              if (isDirectory) {
                filePath += "/";
              }
              const modifiedDate = new Date(modifiedTime);
              controller.enqueue(`<tr>
                <td>${isDirectory ? "📁" : "📄"}</td>
                <td>
                  <a
                    href="${filePath}?${links}"
                    type="${mimeType}"
                  >${name}</a>
                </td>
                <td>
                  <data
                    value="${size}"
                  >${
                size ? formatBytes(Number(size), { locale: true }) : "—"
              }</data>
                </td>
                <td>
                  <time
                    datetime="${modifiedDate.toISOString()}"
                  >${modifiedDate.toLocaleString()}</time>
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
      const file = files[0];
      if (!file) {
        return new Response(null, {
          status: 404,
        });
      }

      const {
        id,
        name,
        mimeType,
        size,
        modifiedTime,
      } = file;

      // Sets initial headers based on file metadata.
      headers.set("Content-Length", String(size));
      headers.set("Content-Type", mimeType);
      headers.set("Last-Modified", String(modifiedTime));

      if (method === "GET") {
        // Retrieves file content.
        const file = await fetchFile(`/${id}`, {
          headers: requestHeaders,
        });
        status = file.status;
        body = file.body;

        // Copies file headers.
        for (const [key, value] of file.headers) {
          if (FILE_HEADERS.has(key)) {
            headers.set(key, value);
          }
        }

        // Patches for MKV file to be playable in browser.
        if (name.endsWith(".mkv")) {
          headers.set("Content-Type", "video/webm");
        }
      }
    }
  }

  if (method === "DELETE") {
    const id = files[0]?.id;
    if (id) {
      const response = await fetchFile(`/${id}`, {
        method,
        headers: requestHeaders,
      });
      status = response.status;
    } else {
      status = 404;
    }
  }

  return new Response(body, {
    status,
    headers,
  });
}

export default {
  fetch: drive,
};
