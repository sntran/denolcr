/**
 * A test server of the S3 API: `rclone serve s3` on a local folder, with the
 * bucket `rfetch`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const RCLONE = process.env.RCLONE || "rclone";

/** The credentials of the test server. */
export const KEYS = {
  access_key_id: "rfetch-key",
  secret_access_key: "rfetch-secret",
};

/**
 * Starts `rclone serve s3` on a free port, with the bucket `rfetch`.
 * @returns {Promise<{ endpoint: string, folder: string, stop: () => void }>}
 */
export async function serveS3() {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-s3-"));
  mkdirSync(join(folder, "data", "rfetch"), { recursive: true });
  const port = await new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const child = spawn(RCLONE, [
    "serve",
    "s3",
    "--auth-key",
    `${KEYS.access_key_id},${KEYS.secret_access_key}`,
    "--addr",
    `127.0.0.1:${port}`,
    join(folder, "data"),
  ], { env: { PATH: process.env.PATH, HOME: folder }, stdio: "ignore" });
  const endpoint = `http://127.0.0.1:${port}`;
  // Waits until the server answers.
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(endpoint);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return {
    endpoint,
    folder,
    stop() {
      child.kill();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
