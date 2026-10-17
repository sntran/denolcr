/**
 * Benchmark of `PUT` of chunker against `rclone rcat` of a chunker remote.
 *
 * `rclone` must be in the PATH. Run with `node backend/chunker/main_bench.js`.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Writable } from "node:stream";
import { bench } from "../../lib/bench.js";
import backend from "./main.js";

const buffer = randomBytes(1024 * 1024 * 10); // 10M
const file = new File([buffer], "10M.bin", {
  type: "application/octet-stream",
});

const chunkSize = 1024 * 1024 * 4; // 4M

/**
 * Sends the file to `rclone rcat` of the remote.
 * @param {string} remote
 */
async function rcat(remote) {
  const rclone = spawn("rclone", ["rcat", `${remote}:${file.name}`], {
    stdio: ["pipe", "ignore", "inherit"],
  });
  await file.stream().pipeTo(Writable.toWeb(rclone.stdin));
  await once(rclone, "close");
}

/**
 * Sends the file to chunker with `PUT`.
 * @param {Record<string, string>} params
 */
async function put(params) {
  const url = new URL(`/${file.name}`, "file:");
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  const response = await backend.fetch(
    new Request(url, { method: "PUT", body: file }),
  );
  await response.arrayBuffer();
}

await bench("backend/chunker: default chunk_size", {
  rfetch: () => put({ remote: ":memory:" }),
  rclone: () => rcat(":chunker,remote=':memory:'"),
});

await bench("backend/chunker: small chunk_size", {
  rfetch: () => put({ remote: ":memory:", chunk_size: `${chunkSize}` }),
  rclone: () => rcat(`:chunker,remote=':memory:',chunk_size=${chunkSize}`),
});
