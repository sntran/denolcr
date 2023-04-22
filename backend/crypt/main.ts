/**
 * Crypt remote
 *
 * Rclone crypt remotes encrypt and decrypt other remotes.
 *
 * A remote of type `crypt` does not access a storage system directly, but
 * instead wraps another remote, which in turn accesses the storage system.
 * This is similar to how `alias`, `union`, `chunker` and a few others work.
 * It makes the usage very flexible, as you can add a layer, in this case an
 * encryption layer, on top of any other backend, even in multiple layers.
 * Rclone's functionality can be used as with any other remote, for example
 * you can mount a crypt remote.
 *
 * Accessing a storage system through a crypt remote realizes client-side
 * encryption, which makes it safe to keep your data in a location you do not
 * trust will not get compromised. When working against the `crypt` remote,
 * rclone will automatically encrypt (before uploading) and decrypt (after
 * downloading) on your local system as needed on the fly, leaving the data
 * encrypted at rest in the wrapped remote. If you access the storage system
 * using an application other than rclone, or access the wrapped remote
 * directly using rclone, there will not be any encryption/decryption:
 * Downloading existing content will just give you the encrypted (scrambled)
 * format, and anything you upload will not become encrypted.
 *
 * The encryption is a secret-key encryption (also called symmetric key
 * encryption) algorithm, where a password (or pass phrase) is used to generate
 * real encryption key. The password can be supplied by user, or you may chose
 * to let rclone generate one. It will be stored in the configuration file, in
 * a lightly obscured form. If you are in an environment where you are not able
 * to keep your configuration secured, you should add configuration encryption
 * as protection. As long as you have this configuration file, you will be able
 * to decrypt your data. Without the configuration file, as long as you
 * remember the password (or keep it in a safe place), you can re-create the
 * configuration and gain access to the existing data. You may also configure a
 * corresponding remote in a different installation to access the same data.
 * See below for guidance to changing password.
 *
 * Encryption uses cryptographic salt, to permute the encryption key so that
 * the same string may be encrypted in different ways. When configuring the
 * crypt remote it is optional to enter a salt, or to let rclone generate a
 * unique salt. If omitted, rclone uses a built-in unique string. Normally in
 * cryptography, the salt is stored together with the encrypted content, and do
 * not have to be memorized by the user. This is not the case in rclone,
 * because rclone does not store any additional information on the remotes. Use
 * of custom salt is effectively a second password that must be memorized.
 *
 * File content encryption is performed using NaCl SecretBox, based on XSalsa20
 * cipher and Poly1305 for integrity. Names (file- and directory names) are
 * also encrypted by default, but this has some implications and is therefore
 * possible to turned off.
 */

import { scrypt } from "https://deno.land/x/scrypto@v1.0.0/scrypt.ts";
import { join } from "../../deps.ts";
import { fetch } from "../../main.ts";
import { reveal } from "../../cmd/obscure/main.ts";
import PathCipher from "./PathCipher.ts";

const DEFAULT_SALT = new Uint8Array([
  0xa8,
  0x0d,
  0xf4,
  0x3a,
  0x8f,
  0xbd,
  0x03,
  0x08,
  0xa7,
  0xca,
  0xb8,
  0x3e,
  0x58,
  0x1f,
  0x86,
  0xb1,
]);

// Params for scrypt
const N = 16384;
const r = 8;
const p = 1;
const keySize = 32 + 32 + 16;

const HEADER_SIZE = 32;
const CHUNK_SIZE = 64 * 1024; // 64KB
const CHUNK_OVERHEAD = 16;
const CRYPTED_CHUNK_SIZE = CHUNK_SIZE + CHUNK_OVERHEAD;

async function router(request: Request) {
  let { pathname, searchParams } = new URL(request.url);

  const remote = searchParams.get("remote");
  if (!remote) {
    throw new Error("Missing remote");
  }

  const password = searchParams.get("password");
  const salt = searchParams.get("password2");

  let response = await deriveKey(password!, salt!)!;
  const key = new Uint8Array(await response.arrayBuffer());

  const pathCipher = PathCipher({
    nameKey: key.slice(32, 64),
    nameTweak: key.slice(64),
  });

  pathname = decodeURIComponent(pathname).slice(1);
  let encryptedPathname = pathname;
  if (pathname !== "") {
    encryptedPathname = pathCipher.encrypt(pathname);
  }

  // Delegates to the underlying remote.
  response = await fetch(join(remote, encryptedPathname), request);
  let { status, statusText, headers, body } = response;
  headers = new Headers(headers);

  // The Link header will be of encrypted names, so we need to decrypt them.
  const links = headers.get("Link")?.split(",").map((link) => {
    const [_, uri] = link.match(/<([^>]*)>/) || [];
    try {
      return `<${pathCipher.decrypt(uri)}>`;
    } catch (_error) {
      return undefined;
    }
  }).filter((l) => l) || [];

  if (links.length) {
    headers.set("Link", links.join(","));
  }

  // The Content-Length header is of the encrypted file, so we need to change
  // it to the decrypted file size.
  let size = Number(headers.get("Content-Length"));
  if (size) {
    size = size - HEADER_SIZE;
    const chunks = Math.floor(size / CRYPTED_CHUNK_SIZE);
    const lastChunk = size % CRYPTED_CHUNK_SIZE;
    size = chunks * CHUNK_SIZE + Math.max(0, lastChunk - CHUNK_OVERHEAD);
    headers.set("Content-Length", String(size));
  }

  return new Response(body, {
    status,
    statusText,
    headers,
  });
}

/**
 * Encode the given filename(s)
 *
 * ```ts
 * import { encode } from "./main.ts";
 * await encode(options, ...arguments);
 * ```
 *
 * This encodes the filenames given as arguments returning a list of strings of
 * the encoded results.
 *
 * Usage Exampe:
 *
 * ```ts
 * import { encode } from "./main.ts";
 * const response = await encode({password, password2}, file1, file2);
 * await response.text();
 * ```
 */
async function encode(options: Record<string, string>, ...args: string[]) {
  const response = await deriveKey(options.password!, options.password2)!;
  const key = new Uint8Array(await response.arrayBuffer());
  const pathCipher = PathCipher({
    nameKey: key.slice(32, 64),
    nameTweak: key.slice(64),
  });
  const encoded = args.map((path) =>
    (path ? pathCipher.encrypt(path) : "") + "\n"
  );

  return new Response(encoded.join(""));
}

/**
 * Decode the given filename(s)
 *
 * ```ts
 * import { decode } from "./main.ts";
 * await decode(options, ..arguments);
 * ```
 *
 * This decodes the filenames given as arguments returning a list of strings of
 * the decoded results. It will return an error if any of the inputs are
 * invalid.
 *
 * Usage Example:
 *
 * ```ts
 * import { decode } from "./main.ts";
 * const response = await decode({password, password2}, encryptedfile1, encryptedfile2);
 * await response.text();
 * ```
 */
async function decode(options: Record<string, string>, ...args: string[]) {
  const response = await deriveKey(options.password!, options.password2)!;
  const key = new Uint8Array(await response.arrayBuffer());
  const pathCipher = PathCipher({
    nameKey: key.slice(32, 64),
    nameTweak: key.slice(64),
  });

  const decoded = args.map((arg) =>
    (arg ? pathCipher.decrypt(arg) : "") + "\n"
  );
  return new Response(decoded.join(""));
}

async function deriveKey(encPass: string, encSalt: string) {
  const password = await reveal(encPass).then((r) => r.arrayBuffer()).then(
    (buf) => new Uint8Array(buf),
  );
  const decryptedSalt = await reveal(encSalt).then((r) => r.arrayBuffer()).then(
    (buf) => new Uint8Array(buf),
  );
  const salt = decryptedSalt.length ? decryptedSalt : DEFAULT_SALT;

  const derivedKey = await scrypt(password, salt, N, r, p, keySize);

  return new Response(derivedKey);
}

const exports = {
  fetch: router,
};

export {
  decode,
  encode,
  // For Cloudflare Workers.
  exports as default,
  router as fetch,
};

// Learn more at https://deno.land/manual/examples/module_metadata#concepts
if (import.meta.main) {
  Deno.serve(router);
}
