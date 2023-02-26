export async function create(request: Request): Promise<Response> {
  const headers = request.headers;
  const { pathname, searchParams } = new URL(request.url);

  const mimeType = headers.get("Content-Type");
  const name = pathname.split("/").pop();
  const driveId = searchParams.get("team_drive");
  const rootFolderId = searchParams.get("root_folder_id");

  const parents: string[] = [];
  const parent = rootFolderId || driveId;
  if (parent) {
    parents.push(parent);
  }

  const metadata = {
    name,
    mimeType,
    parents,
  };

  const url = new URL("https://www.googleapis.com/upload/drive/v3/files");
  url.searchParams.set("uploadType", "resumable");

  if (driveId) {
    url.searchParams.set("supportsAllDrives", "true");
  }

  headers.set("Content-Type", "application/json; charset=UTF-8");

  // Initializes a request for upload URL.
  let response = await fetch(url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(metadata),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const location = response.headers.get("Location");
  if (!location) {
    throw new Error("Location header not found");
  }

  // Minimum chunk size is 256 KiB.
  const chunkSize = Number(searchParams.get("chunk_size")) || 256 * 1024;
  const body = request.body!.pipeThrough(new Chunker(chunkSize));
  const reader = body.getReader();

  let chunk = new Uint8Array(chunkSize);
  let start = 0;

  // Because we don't know the size of the stream, we have to read them chunks by
  // chunks, until the reader reports that it has reached the end of the stream.
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunk = value;
    const byteLength = chunk.byteLength;
    const end = start + byteLength;
    let total = "*";
    if (byteLength < chunkSize) {
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

  return response;
}

/**
 * A TransformStream that slices into chunks of a given size.
 */
class Chunker extends TransformStream<Uint8Array, Uint8Array> {
  constructor(chunkSize: number) {
    let partialChunk = new Uint8Array(chunkSize);
    let offset = 0;

    function transform(chunk: Uint8Array, controller: TransformStreamDefaultController) {
      let i = 0;

      if (offset > 0) {
        const len = Math.min(chunk.byteLength, chunkSize - offset);
        partialChunk.set(chunk.slice(0, len), offset);
        offset += len;
        i += len;

        if (offset === chunkSize) {
          controller.enqueue(partialChunk);
          partialChunk = new Uint8Array(chunkSize);
          offset = 0;
        }
      }

      while (i < chunk.byteLength) {
        const remainingBytes = chunk.byteLength - i;
        if (remainingBytes >= chunkSize) {
          const record = chunk.slice(i, i + chunkSize);
          i += chunkSize;
          controller.enqueue(record);
          partialChunk = new Uint8Array(chunkSize);
          offset = 0;
        } else {
          const end = chunk.slice(i, i + remainingBytes);
          i += end.byteLength;
          partialChunk.set(end);
          offset = end.byteLength;
        }
      }
    }

    function flush(controller: TransformStreamDefaultController) {
      if (offset > 0) {
        controller.enqueue(partialChunk.slice(0, offset));
      }
    }

    super({
      transform,
      flush,
    });
  }
}
