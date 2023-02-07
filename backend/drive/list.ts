const FILE_ATTRS =
  "id, name, mimeType, size, modifiedTime, description, iconLink, thumbnailLink, imageMediaMetadata";

export async function list(request: Request): Promise<Response> {
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

  return await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers,
  });
}
