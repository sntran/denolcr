/**
 * The test servers of FTP, on a local folder, with a user and a password:
 *
 * - `rclone serve ftp`, with no TLS. It runs when rclone is in the PATH, or
 *   when RCLONE is the path of rclone. Its TLS from the start refuses PBSZ
 *   and PROT, thus the ftp backend of rclone cannot use it.
 * - pyftpdlib, with no TLS, with `AUTH TLS` (explicit FTPS) or with TLS
 *   from the start (implicit FTPS), and with MFMT, which sets the time of a
 *   file. It runs when the Python of PYFTPDLIB_PYTHON, or `python3`, has
 *   pyftpdlib and pyOpenSSL.
 *
 * The certificates of TLS come from openssl.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const RCLONE = process.env.RCLONE || "rclone";
const PYTHON = process.env.PYFTPDLIB_PYTHON || "python3";

/** Tells if rclone is installed. */
export const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

/** Tells if openssl is installed. */
export const hasOpenSSL = spawnSync("openssl", ["version"]).status === 0;

/** Tells if pyftpdlib and pyOpenSSL are installed. */
export const hasPyftpdlib =
  spawnSync(PYTHON, ["-I", "-c", "import pyftpdlib, OpenSSL"]).status === 0;

/** The user and the password of the test servers. */
export const LOGIN = { user: "rfetch-user", pass: "rfetch pass é" };

/**
 * A server of pyftpdlib: the arguments are the folder, the port, the user,
 * the password, the TLS (`explicit`, `implicit` or ""), and the files of
 * the certificate and of the key.
 */
const PYFTPDLIB_SERVER = `
import sys
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
from pyftpdlib.servers import FTPServer


class ImplicitTLSHandler(TLS_FTPHandler):
    # TLS starts before the first answer, as after AUTH TLS.
    def handle(self):
        self.secure_connection(self.ssl_context)
        super().handle()


folder, port, user, password, tls, cert, key = sys.argv[1:8]
authorizer = DummyAuthorizer()
authorizer.add_user(user, password, folder, perm="elradfmwMT")
handler = {
    "explicit": TLS_FTPHandler,
    "implicit": ImplicitTLSHandler,
}.get(tls, FTPHandler)
if tls:
    handler.certfile = cert
    handler.keyfile = key
    handler.tls_control_required = True
    handler.tls_data_required = True
handler.authorizer = authorizer
handler.encoding = "utf8"
server = FTPServer(("127.0.0.1", int(port)), handler)
server.serve_forever()
`;

/**
 * Gives a free port of 127.0.0.1.
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Makes a certificate for `localhost` and `127.0.0.1`, signed by itself.
 * @param {string} folder
 * @returns {{ cert: string, key: string }} The files of the certificate and
 *   of its key, in PEM.
 */
export function makeCertificate(folder) {
  const cert = join(folder, "cert.pem");
  const key = join(folder, "key.pem");
  const { status, stderr } = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { encoding: "utf8" });
  if (status !== 0) throw new Error(`openssl: ${stderr}`);
  return { cert, key };
}

/**
 * Waits until a port takes connections.
 * @param {number} port
 */
async function waitForPort(port) {
  for (let i = 0; i < 100; i++) {
    const open = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No server on the port ${port}`);
}

/**
 * A test server.
 * @typedef {Object} TestServer
 * @property {string} host
 * @property {number} port
 * @property {string} folder The local folder of the server.
 * @property {string} [cert] The file of the certificate of TLS.
 * @property {() => void} stop
 */

/**
 * Starts `rclone serve ftp` on a free port.
 * @returns {Promise<TestServer>}
 */
export async function serveRclone() {
  const home = mkdtempSync(join(tmpdir(), "rfetch-ftp-"));
  const folder = join(home, "data");
  mkdirSync(folder);
  const port = await freePort();
  const args = [
    "serve",
    "ftp",
    "--user",
    LOGIN.user,
    "--pass",
    LOGIN.pass,
    "--addr",
    `127.0.0.1:${port}`,
  ];
  args.push(folder);
  const child = spawn(RCLONE, args, {
    env: { PATH: process.env.PATH, HOME: home },
    stdio: "ignore",
  });
  await waitForPort(port);
  return {
    host: "127.0.0.1",
    port,
    folder,
    stop() {
      child.kill();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Starts a server of pyftpdlib on a free port.
 * @param {Object} [options]
 * @param {"explicit" | "implicit"} [options.tls] Explicit or implicit
 *   FTPS: the server wants TLS for the control and the data connections.
 * @returns {Promise<TestServer>}
 */
export async function servePyftpdlib({ tls } = {}) {
  const home = mkdtempSync(join(tmpdir(), "rfetch-ftp-"));
  const folder = join(home, "data");
  mkdirSync(folder);
  const script = join(home, "server.py");
  writeFileSync(script, PYFTPDLIB_SERVER);
  const port = await freePort();
  const files = tls ? makeCertificate(home) : { cert: "", key: "" };
  const child = spawn(
    PYTHON,
    [
      "-I",
      script,
      folder,
      `${port}`,
      LOGIN.user,
      LOGIN.pass,
      tls ?? "",
      files.cert,
      files.key,
    ],
    {
      env: { PATH: process.env.PATH, HOME: home, TZ: "UTC" },
      stdio: "ignore",
    },
  );
  await waitForPort(port);
  return {
    host: "127.0.0.1",
    port,
    folder,
    cert: files.cert || undefined,
    stop() {
      child.kill();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
