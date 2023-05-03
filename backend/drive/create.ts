import { Chunker } from "../../lib/streams/chunker.ts";

import { File } from "./File.ts";

export async function create(request: Request): Promise<Response> {
  const { headers, redirect = "follow" } = request;
  const { pathname, searchParams } = new URL(request.url);

  const mimeType = headers.get("Content-Type") || "";
  const name = pathname.split("/").pop()!;
  const driveId = searchParams.get("team_drive");
  const rootFolderId = searchParams.get("root_folder_id");

  const parents: string[] = [];
  const parent = rootFolderId || driveId;
  if (parent) {
    parents.push(parent);
  }

  // Pre-generate file ID.
  let url = new URL("https://www.googleapis.com/drive/v3/files/generateIds");
  url.searchParams.set("count", "1");
  url.searchParams.set("space", "drive");
  url.searchParams.set("type", "files");
  let response = await fetch(url, {
    method: "GET",
    headers,
  });
  const { ids: [id] } = await response.json();
  const contentLocation = `https://drive.google.com/file/d/${id}`;

  const metadata: File = {
    id, // pre-generated file ID
    name,
    mimeType,
    parents,
  };

  url = new URL("https://www.googleapis.com/upload/drive/v3/files");
  url.searchParams.set("uploadType", "resumable");

  if (driveId) {
    url.searchParams.set("supportsAllDrives", "true");
  }

  // Required if metadata is included.
  headers.set("Content-Type", "application/json; charset=UTF-8");

  // Initializes a request for upload URL.
  response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(metadata),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const location = response.headers.get("Location");
  if (!location) {
    throw new Error("Location header not found");
  }

  if (redirect === "manual") {
    return new Response(null, {
      status: 307,
      headers: {
        location,
        "Content-Location": contentLocation,
      },
    });
  }
  if (redirect === "error") {
    throw new Error(`Redirected to ${location}`);
  }

  // Minimum chunk size is 256 KiB.
  const chunkSize = Number(searchParams.get("chunk_size")) || 256 * 1024;
  const body = request.body!.pipeThrough(new Chunker(chunkSize));
  const reader = body.getReader();

  let chunk = null;
  let start = 0;

  // Because we don't know the size of the stream, we have to read them chunks by
  // chunks, until the reader reports that it has reached the end of the stream.
  while (true) {
    const { done, value } = await reader.read();

    if (chunk) {
      const byteLength = chunk.byteLength;
      const end = start + byteLength;

      let total = "*";
      if (done) {
        // Last chunk
        total = `${end}`;
      }

      headers.set("Content-Length", `${byteLength}`);
      headers.set("Content-Range", `bytes ${start}-${end - 1}/${total}`);

      response = await fetch(location, {
        method: "PUT",
        headers: headers,
        body: chunk,
      });

      if (response.status >= 500) {
        throw new Error(await response.text());
      }

      start = end;
    }

    if (done) {
      break;
    }

    chunk = value;
  }

  return response;
}
