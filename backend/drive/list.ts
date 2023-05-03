import { File } from "./File.ts";

const BASE_URL = "https://www.googleapis.com/drive/v3/files";
const FILE_ATTRS =
  "id, name, mimeType, size, md5Checksum, modifiedTime, parents";

interface Result {
  error?: string;
  code?: number;
  message?: string;
  files: File[];
  nextPageToken?: string;
}

export async function list(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (typeof input === "string") {
    input = new URL(input, "drive:/");
  }

  if (input instanceof URL) {
    input = new Request(input);
  }

  input = new Request(input, init);

  const headers = input.headers;
  const { searchParams } = new URL(input.url);

  // Shared Drive or My Drive
  const driveId = searchParams.get("team_drive") || "";
  const rootFolderId = searchParams.get("root_folder_id");

  const url = new URL(BASE_URL);
  const params = url.searchParams;
  params.set("corpora", driveId ? "drive" : "user");
  params.set("fields", `files(${FILE_ATTRS})`);

  if (driveId) {
    params.set("driveId", driveId);
    params.set("includeItemsFromAllDrives", "true");
    params.set("supportsAllDrives", "true");
  }

  let query = "trashed = false";

  if (rootFolderId) {
    query += ` and '${rootFolderId}' in parents`;
  }

  const mimeType = headers.get("Content-Type");
  if (mimeType) {
    query += ` and mimeType = '${mimeType}'`;
  }

  params.set("pageSize", "1000");
  params.set("fields", `files(${FILE_ATTRS}),nextPageToken`);
  params.set("q", query);

  const data = [];

  let nextPageToken = "";
  do {
    url.searchParams.set("pageToken", nextPageToken);
    const response = await fetch(url, { headers });
    const { files = [], nextPageToken: token }: Result = await response.json();
    data.push(...files);
    nextPageToken = token!;
  } while (nextPageToken);

  return Response.json(data);
}
