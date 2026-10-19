/**
 * A test server of SFTP: `rclone serve sftp` on a local folder, with a user
 * and a password, the host keys of the tests and the authorized keys of
 * the tests. The tests run when rclone is in the PATH, or when RCLONE is the
 * path of rclone.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { readPrivateKey } from "./ssh/keys.js";
import { Reader, Writer } from "./ssh/wire.js";

const RCLONE = process.env.RCLONE || "rclone";

/** Tells if rclone is installed. */
export const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

/** The user and the password of the test server. */
export const LOGIN = { user: "rfetch-user", pass: "rfetch pass é" };

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
 * Starts `rclone serve sftp` on a free port.
 * @param {Object} [options]
 * @param {string[]} [options.hostKeys] The private keys of the server, in
 *   PEM.
 * @param {string[]} [options.authorizedKeys] The public keys of the users,
 *   as lines of `authorized_keys`.
 * @returns {Promise<{ host: string, port: number, folder: string, stop: () => void }>}
 *   `folder` is the local folder of the server.
 */
export async function serveSFTP({ hostKeys = [], authorizedKeys = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "rfetch-sftp-"));
  const folder = join(home, "data");
  mkdirSync(folder);
  const port = await freePort();
  const args = [
    "serve",
    "sftp",
    "--user",
    LOGIN.user,
    "--pass",
    LOGIN.pass,
    "--addr",
    `127.0.0.1:${port}`,
  ];
  hostKeys.forEach((pem, index) => {
    const file = join(home, `host_key_${index}`);
    writeFileSync(file, pem, { mode: 0o600 });
    args.push("--key", file);
  });
  const authorized = join(home, "authorized_keys");
  writeFileSync(authorized, authorizedKeys.map((line) => `${line}\n`).join(""));
  args.push("--authorized-keys", authorized, folder);
  const child = spawn(RCLONE, args, {
    env: { PATH: process.env.PATH, HOME: home },
    stdio: "ignore",
  });
  // Waits until the server takes connections.
  for (let i = 0; i < 100; i++) {
    const open = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
 * Makes a private key with openssl, in PEM.
 * @param {"ed25519" | "ecdsa" | "rsa"} type
 * @param {"pkcs8" | "traditional"} [format] `traditional` is PKCS #1 for
 *   RSA and SEC 1 for ECDSA.
 * @returns {string}
 */
export function makeKey(type, format = "pkcs8") {
  const args = {
    ed25519: ["genpkey", "-algorithm", "ed25519"],
    ecdsa: [
      "genpkey",
      "-algorithm",
      "EC",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
    ],
    rsa: ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"],
  }[type];
  let pem = spawnSync("openssl", args, { encoding: "utf8" }).stdout;
  if (format === "traditional") {
    // `openssl ec` writes SEC 1, and `openssl rsa -traditional` PKCS #1.
    pem = spawnSync(
      "openssl",
      type === "rsa" ? ["rsa", "-traditional"] : ["ec"],
      { input: pem, encoding: "utf8" },
    ).stdout;
  }
  return pem;
}

/** Tells if openssl is installed. */
export const hasOpenSSL = spawnSync("openssl", ["version"]).status === 0;

/**
 * Writes a private key in the format of OpenSSH, with no passphrase.
 * @param {JsonWebKey} jwk The private key.
 * @param {Uint8Array} blob The public key in the format of SSH.
 */
export function openSSHKey(jwk, blob) {
  /** @param {string | undefined} text */
  const bytes = (text) => new Uint8Array(Buffer.from(text ?? "", "base64url"));
  const type = new Reader(blob).string();
  const secret = new Writer().uint32(7).uint32(7).string(type);
  if (type === "ssh-ed25519") {
    secret.string(bytes(jwk.x));
    secret.string(Buffer.concat([bytes(jwk.d), bytes(jwk.x)]));
  } else if (type === "ssh-rsa") {
    for (const field of ["n", "e", "d", "qi", "p", "q"]) {
      secret.mpint(bytes(jwk[field]));
    }
  } else {
    const reader = new Reader(blob);
    reader.string();
    secret.string(reader.string()).string(reader.bytes()).mpint(bytes(jwk.d));
  }
  secret.string("comment");
  const padded = secret.bytes();
  /** @type {number[]} */
  const padding = [];
  for (let i = 1; (padded.length + padding.length) % 8 !== 0; i++) {
    padding.push(i);
  }
  const body = new Writer()
    .raw(new TextEncoder().encode("openssh-key-v1\0"))
    .string("none")
    .string("none")
    .string("")
    .uint32(1)
    .string(blob)
    .string(Buffer.concat([padded, Uint8Array.from(padding)]))
    .bytes();
  const base64 = Buffer.from(body).toString("base64").replace(/.{70}/g, "$&\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/**
 * Makes a key with WebCrypto, as PKCS #8 in PEM and as OpenSSH.
 * @param {RsaHashedKeyGenParams | EcKeyGenParams | Algorithm} params
 */
export async function makeKeys(params) {
  const pair = /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey(params, true, ["sign", "verify"])
  );
  const pkcs8 = Buffer.from(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ).toString("base64").replace(/.{64}/g, "$&\n");
  const pem =
    `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`;
  const key = await readPrivateKey(pem);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { pem, key, openssh: openSSHKey(jwk, key.blob) };
}

/** The parameters of WebCrypto of the keys of the tests, by type. */
export const KEY_PARAMS = {
  ed25519: { name: "Ed25519" },
  "ecdsa p256": { name: "ECDSA", namedCurve: "P-256" },
  "ecdsa p384": { name: "ECDSA", namedCurve: "P-384" },
  "ecdsa p521": { name: "ECDSA", namedCurve: "P-521" },
  rsa: {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
};
