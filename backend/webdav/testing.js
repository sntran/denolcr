/**
 * A test server of WebDAV: `rclone serve webdav` on a local folder, with a
 * user and a password.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const RCLONE = process.env.RCLONE || "rclone";

/** The user and the password of the test server. */
export const LOGIN = { user: "rfetch-user", pass: "rfetch pass é" };

/**
 * Gives a free port of 127.0.0.1.
 * @returns {Promise<number>}
 */
export function freePort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts `rclone serve webdav` on a free port.
 * @returns {Promise<{ url: string, folder: string, stop: () => void }>}
 *   `url` is the root of the server, and `folder` is its local folder.
 */
export async function serveWebDAV() {
  const home = mkdtempSync(join(tmpdir(), "rfetch-webdav-"));
  const folder = join(home, "data");
  const port = await freePort();
  const child = spawn(RCLONE, [
    "serve",
    "webdav",
    "--user",
    LOGIN.user,
    "--pass",
    LOGIN.pass,
    "--addr",
    `127.0.0.1:${port}`,
    folder,
  ], { env: { PATH: process.env.PATH, HOME: home }, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}/`;
  // Waits until the server answers.
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url, { method: "OPTIONS" });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return {
    url,
    folder,
    stop() {
      child.kill();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
