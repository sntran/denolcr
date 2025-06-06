import { mkBuffer } from "../../deps.js";
import backend from "./main.js";

const buffer = mkBuffer(1024 * 1024 * 10); // 10M
const file = new File([buffer], "10M.bin", {
  type: "application/octet-stream",
});

const chunkSize = 1024 * 1024 * 4; // 4M

//#region No chunking
Deno.bench(
  "rclone",
  { group: "backend/chunker: default chunk_size" },
  async () => {
    const rclone = new Deno.Command("rclone", {
      args: [
        "rcat",
        `:chunker,remote=':memory:':${file.name}`,
      ],
      stdin: "piped",
    });
    const rcat = rclone.spawn();
    file.stream().pipeTo(rcat.stdin);
    await rcat.status;
  },
);

Deno.bench("rfetch", {
  group: "backend/chunker: default chunk_size",
  baseline: true,
}, async () => {
  const url = new URL(`/${file.name}`, "file:");
  url.searchParams.set("remote", ":memory:");

  const response = await backend.fetch(
    new Request(url, {
      method: "PUT",
      body: file,
    }),
  );
  await response.arrayBuffer();
});
//#endregion No chunking

//#region Chunking
Deno.bench(
  "rclone",
  { group: "backend/chunker: small chunk_size" },
  async () => {
    const rclone = new Deno.Command("rclone", {
      args: [
        "rcat",
        `:chunker,remote=':memory:',chunk_size=${chunkSize}:${file.name}`,
      ],
      stdin: "piped",
    });
    const rcat = rclone.spawn();
    file.stream().pipeTo(rcat.stdin);
    await rcat.status;
  },
);

Deno.bench("rfetch", {
  group: "backend/chunker: small chunk_size",
  baseline: true,
}, async () => {
  const url = new URL(`/${file.name}`, "file:");
  url.searchParams.set("remote", ":memory:");
  url.searchParams.set("chunk_size", `${chunkSize}`);

  const response = await backend.fetch(
    new Request(url, {
      method: "PUT",
      body: file,
    }),
  );
  await response.arrayBuffer();
});
//#endregion Chunking
