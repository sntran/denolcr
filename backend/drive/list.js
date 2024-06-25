const BASE_URL = "https://www.googleapis.com/drive/v3/files";
const FOLDER_TYPE = "application/vnd.google-apps.folder";
const FILE_ATTRS =
  "id, name, mimeType, size, md5Checksum, modifiedTime, parents";

/**
 * @typedef {Object} Result
 * @property {string} [error]
 * @property {number} [code]
 * @property {string} [message]
 * @property {Object[]} [files]
 * @property {string} [nextPageToken]
 */

/**
 * List files and folders by pathname.
 *
 * If the pathname ends with a slash, it will list the contents of the folder.
 * Otherwise, it will return the file/folder metadata.
 *
 * @param {string | URL | Request} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function list(input, init) {
  if (typeof input === "string") {
    input = new URL(input, "drive:/");
  }

  if (input instanceof URL) {
    input = new Request(input);
  }

  input = new Request(input, init);

  const headers = input.headers;
  let { pathname, searchParams } = new URL(input.url);
  pathname = decodeURIComponent(pathname);

  // Shared Drive or My Drive
  const driveId = searchParams.get("team_drive") || "";
  const rootFolderId = searchParams.get("root_folder_id");
  const fields = searchParams.get("fields") || FILE_ATTRS;

  const url = new URL(BASE_URL);
  const params = url.searchParams;
  params.set("corpora", driveId ? "drive" : "user");

  if (driveId) {
    params.set("driveId", driveId);
    params.set("includeItemsFromAllDrives", "true");
    params.set("supportsAllDrives", "true");
  }

  params.set("pageSize", "1000");
  params.set("fields", `files(${fields}),nextPageToken`);

  const [, ...segments] = pathname.split("/");
  const target = segments.pop();
  let parentId = rootFolderId || driveId || "root";

  // Retrieves the parent
  for await (const segment of segments) {
    let query = `trashed = false and '${parentId}' in parents`;
    query += ` and name = '${segment}' and mimeType = '${FOLDER_TYPE}'`;
    params.set("q", query);
    const { files = [] } = await fetch(url, { headers }).then((r) => r.json());
    parentId = files[0]?.id;
    if (!parentId) {
      return new Response("Not Found", { status: 404 });
    }
  }

  let query = `trashed = false and '${parentId}' in parents`;
  if (target) {
    query += ` and name = '${target}'`;
  }
  params.set("q", query);

  const data = [];

  let nextPageToken = "";
  do {
    url.searchParams.set("pageToken", nextPageToken);
    const response = await fetch(url, { headers });
    /** @type {Result} */
    const { files = [], nextPageToken: token } = await response.json();
    data.push(...files);
    nextPageToken = token;
  } while (nextPageToken);

  return Response.json(data);
}
