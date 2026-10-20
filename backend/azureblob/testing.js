/**
 * A test server of the Blob service of Azure: Azurite, the emulator of
 * Azure Storage, with its data in memory. The tests run when
 * `azurite-blob` is in the PATH, or when AZURITE is the path of
 * `azurite-blob`.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import process from "node:process";

const AZURITE = process.env.AZURITE || "azurite-blob";

/** Tells if Azurite is installed. */
export const hasAzurite =
  spawnSync(AZURITE, ["--version"], { stdio: "ignore" }).status === 0;

/**
 * The account of the emulator: its name and its key are public, in the
 * documents of Azure.
 */
export const EMULATOR = {
  account: "devstoreaccount1",
  key:
    "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
};

/**
 * Starts Azurite on a free port, with its data in memory.
 * @returns {Promise<{ endpoint: string, stop: () => void }>} The endpoint
 *   has the account in its path, for example
 *   `http://127.0.0.1:10000/devstoreaccount1`.
 */
export async function serveAzurite() {
  const port = await new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const child = spawn(AZURITE, [
    "--silent",
    "--inMemoryPersistence",
    "--skipApiVersionCheck",
    "--blobHost",
    "127.0.0.1",
    "--blobPort",
    `${port}`,
  ], { env: { PATH: process.env.PATH }, stdio: "ignore" });
  const endpoint = `http://127.0.0.1:${port}/${EMULATOR.account}`;
  // Waits until the server answers.
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(endpoint);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return { endpoint, stop: () => child.kill() };
}
