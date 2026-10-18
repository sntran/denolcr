/**
 * Crypt remote
 *
 * rfetch crypt remotes encrypt and decrypt other remotes.
 *
 * A remote of type `crypt` does not access a storage system directly, but
 * instead wraps another remote, which in turn accesses the storage system.
 * This is similar to how `alias`, `union`, `chunker` and a few others work.
 * It makes the usage very flexible, as you can add a layer, in this case an
 * encryption layer, on top of any other backend, even in multiple layers.
 * rfetch's functionality can be used as with any other remote, for example
 * you can mount a crypt remote.
 *
 * Accessing a storage system through a crypt remote realizes client-side
 * encryption, which makes it safe to keep your data in a location you do not
 * trust will not get compromised. When working against the `crypt` remote,
 * rfetch will automatically encrypt (before uploading) and decrypt (after
 * downloading) on your local system as needed on the fly, leaving the data
 * encrypted at rest in the wrapped remote. If you access the storage system
 * using an application other than rfetch, or access the wrapped remote
 * directly using rfetch, there will not be any encryption/decryption:
 * Downloading existing content will just give you the encrypted (scrambled)
 * format, and anything you upload will not become encrypted.
 *
 * The encryption is a secret-key encryption (also called symmetric key
 * encryption) algorithm, where a password (or pass phrase) is used to generate
 * real encryption key. The password can be supplied by user, or you may chose
 * to let rfetch generate one. It will be stored in the configuration file, in
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
 * crypt remote it is optional to enter a salt, or to let rfetch generate a
 * unique salt. If omitted, rfetch uses a built-in unique string. Normally in
 * cryptography, the salt is stored together with the encrypted content, and do
 * not have to be memorized by the user. This is not the case in rfetch,
 * because rfetch does not store any additional information on the remotes. Use
 * of custom salt is effectively a second password that must be memorized.
 *
 * File content encryption is performed using NaCl SecretBox, based on XSalsa20
 * cipher and Poly1305 for integrity. Names (file- and directory names) are
 * also encrypted by default, but this has some implications and is therefore
 * possible to turned off.
 *
 * Files are encrypted 1:1 source file to destination object. The file has a
 * header and is divided into chunks.
 *
 * ## Header
 *
 * - 8 bytes magic string `RCLONE\x00\x00`
 * - 24 bytes Nonce (IV)
 *
 * The initial nonce is generated from the operating systems crypto strong
 * random number generator. The nonce is incremented for each chunk read making
 * sure each nonce is unique for each block written. The chance of a nonce
 * being re-used is minuscule. If you wrote an exabyte of data (10¹⁸ bytes) you
 * would have a probability of approximately 2×10⁻³² of re-using a nonce.
 *
 * ## Chunk
 *
 * Each chunk will contain 64 KiB of data, except for the last one which may
 * have less data. The data chunk is in standard NaCl SecretBox format.
 * SecretBox uses XSalsa20 and Poly1305 to encrypt and authenticate messages.
 *
 * Each chunk contains:
 * - 16 Bytes of Poly1305 authenticator
 * - 1 - 65536 bytes XSalsa20 encrypted data
 *
 * 64k chunk size was chosen as the best performing chunk size (the
 * authenticator takes too much time below this and the performance drops off
 * due to cache effects above this). Note that these chunks are buffered in
 * memory so they can't be too big.
 *
 * This uses a 32 byte (256 bit key) key derived from the user password.
 *
 * ## Examples
 *
 * 1 byte file will encrypt to
 * - 32 bytes header
 * - 17 bytes data chunk
 * - 49 bytes total

 * 1 MiB (1048576 bytes) file will encrypt to
 * - 32 bytes header
 * - 16 chunks of 65568 bytes
 * - 1049120 bytes total (a 0.05% overhead). This is the overhead for big files.
 */

import { scrypt } from "node:crypto";
import { readListing, renderListing } from "@rfetch/lib/listing";
import { mimeType } from "@rfetch/lib/mime";
import { optionsOf, remoteHeaders } from "@rfetch/lib/options";
import { decodePath } from "@rfetch/lib/path";
import {
  notSatisfiable,
  parseRange,
  partialHeaders,
  sliceStream,
} from "@rfetch/lib/range";
import { sized } from "@rfetch/lib/sized";
import { reveal } from "@rfetch/lib/obscure";
import PathCipher from "./PathCipher.js";
import {
  decryptedSize,
  DecryptionStream,
  encryptedSize,
  EncryptionStream,
  Errors,
} from "./secretbox.js";

const encoder = new TextEncoder();

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
const N = 2 ** 14; // 16384
const r = 8;
const p = 1;
const dkLen = 32 + 32 + 16;
/** The memory that scrypt can use: it needs 128 * N * r bytes, 16 MiB. */
const SCRYPT_MEMORY = 2 * 128 * N * r;

const SECRETBOX_OPTIONS = {
  blockSize: 64 * 1024, // 64 KiB
  magic: encoder.encode("RCLONE\x00\x00"),
};

/**
 * The options that are secret. They are not in the links of a list, which a
 * browser can keep in its history and send to other sites.
 */
const SECRETS = ["password", "password2"];

/**
 * Serves a crypted remote. The requests to the remote under crypt go to the
 * global `fetch`.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_CRYPT_*` or `RCLONE_CRYPT_*`.
 * @returns {Promise<Response>}
 */
async function crypt(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);

  const path = decodePath(pathname);
  if (path === null) {
    return new Response(null, { status: 400 });
  }

  const options = optionsOf(request, "crypt", env);
  const remote = options.get("remote")?.replace(/\/$/, "");
  if (!remote) {
    return new Response("Missing remote", { status: 400 });
  }
  if (!options.get("password")) {
    return new Response("Missing password", { status: 400 });
  }

  let cipher;
  try {
    cipher = await cipherOf(
      options.get("password"),
      options.get("password2") ?? "",
    );
  } catch {
    return new Response("The password is not obscured", { status: 400 });
  }

  const isDirectory = path.endsWith("/");
  const target = remote + cipher.names.encrypt(path);

  // The data on the remote is encrypted, thus a range of the data is not a
  // range of the file.
  const headers = remoteHeaders(request.headers, "crypt", remote);
  headers.delete("Range");

  const range = request.headers.get("Range");
  if (method === "GET" && !isDirectory && range !== null) {
    return await getRange(target, headers, cipher, path, range);
  }

  if (method === "GET" || method === "HEAD") {
    const response = await fetch(target, { method, headers });
    if (!response.ok) {
      return response;
    }
    if (isDirectory) {
      return await listing(response, cipher, searchParams);
    }

    const result = new Headers({
      "Content-Type": mimeType(path),
      "Accept-Ranges": "bytes",
    });
    const size = sizeOf(response.headers.get("Content-Length"));
    if (size >= 0) {
      result.set("Content-Length", `${size}`);
    }
    const lastModified = response.headers.get("Last-Modified");
    if (lastModified) {
      result.set("Last-Modified", lastModified);
    }

    let body = null;
    if (method === "GET" && response.body) {
      body = response.body.pipeThrough(
        new DecryptionStream(cipher.dataKey, SECRETBOX_OPTIONS),
      );
      if (size >= 0) body = sized(body, size);
    } else {
      await response.body?.cancel();
    }
    return new Response(body, { status: response.status, headers: result });
  }

  if (method === "PUT") {
    // The remote does not get the type of the file: the type tells about
    // the content.
    headers.delete("Content-Type");
    /** @type {RequestInit} */
    const init = { method, headers };
    if (!isDirectory) {
      const length = request.headers.get("Content-Length");
      headers.delete("Content-Length");
      if (length !== null && /^\d+$/.test(length)) {
        headers.set(
          "Content-Length",
          `${encryptedSize(Number(length), SECRETBOX_OPTIONS)}`,
        );
      }
      const body = request.body ?? ReadableStream.from([]);
      init.body = body.pipeThrough(
        new EncryptionStream(cipher.dataKey, SECRETBOX_OPTIONS),
      );
      init.duplex = "half";
    }

    const response = await fetch(target, init);
    await response.body?.cancel();
    const result = new Headers();
    if (response.ok) {
      result.set("Content-Location", pathname);
    }
    return new Response(null, { status: response.status, headers: result });
  }

  if (method === "DELETE") {
    const response = await fetch(target, { method, headers });
    await response.body?.cancel();
    return new Response(null, { status: response.status });
  }

  return new Response(null, {
    status: 405,
    headers: { Allow: "GET, HEAD, PUT, DELETE" },
  });
}

/**
 * Gets a range of a file, as the seek of rclone: the header of the
 * encrypted file gives its nonce and its size, then only the blocks of the
 * range are read and decrypted. When the remote sends all the file for a
 * range, all the file is decrypted, and the answer has the range only.
 * @param {string} target The encrypted path on the remote.
 * @param {Headers} headers The headers of the request, with no `Range`.
 * @param {{ dataKey: Uint8Array }} cipher
 * @param {string} path The path of the file.
 * @param {string} header The `Range` of the request.
 * @returns {Promise<Response>}
 */
async function getRange(target, headers, cipher, path, header) {
  const { magic, blockSize } = SECRETBOX_OPTIONS;
  const headerSize = magic.length + 24;
  const blockLength = blockSize + 16;

  const init = { headers: new Headers(headers) };
  init.headers.set("Range", `bytes=0-${headerSize - 1}`);
  const first = await fetch(target, init);
  if (first.status === 416) {
    // The encrypted file is shorter than its header.
    return new Response(Errors.TOO_SHORT, { status: 500 });
  }
  if (!first.ok) {
    return first;
  }

  // The size of the encrypted file.
  const total = first.status === 206
    ? first.headers.get("Content-Range")?.match(/\/(\d+)$/)?.[1] ?? null
    : first.headers.get("Content-Length");
  const size = sizeOf(total);
  if (size < 0) {
    await first.body?.cancel();
    return new Response("The size of the encrypted file is not correct", {
      status: 500,
    });
  }

  let range;
  try {
    range = parseRange(header, size);
  } catch {
    await first.body?.cancel();
    return notSatisfiable(size);
  }

  const result = new Headers({
    "Content-Type": mimeType(path),
    "Accept-Ranges": "bytes",
  });
  const lastModified = first.headers.get("Last-Modified");
  if (lastModified) result.set("Last-Modified", lastModified);
  const decrypt = (options) =>
    new DecryptionStream(cipher.dataKey, { ...SECRETBOX_OPTIONS, ...options });

  if (first.status !== 206) {
    // The remote sent all the file.
    let body = first.body.pipeThrough(decrypt());
    let length = size;
    if (range) {
      length = range.end - range.start + 1;
      body = sliceStream(body, range.start, length);
      for (const [name, value] of Object.entries(partialHeaders(range, size))) {
        result.set(name, value);
      }
    } else {
      result.set("Content-Length", `${size}`);
    }
    return new Response(sized(body, length), {
      status: range ? 206 : 200,
      headers: result,
    });
  }

  const bytes = new Uint8Array(await first.arrayBuffer());
  if (
    bytes.length < headerSize ||
    magic.some((byte, index) => bytes[index] !== byte)
  ) {
    return new Response(Errors.BAD_MAGIC, { status: 500 });
  }
  const nonce = bytes.slice(magic.length, headerSize);
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  if (length === 0) {
    result.set("Content-Length", "0");
    return new Response(null, { headers: result });
  }

  // The blocks of the range.
  const block = Math.floor(start / blockSize);
  const lastBlock = Math.floor(end / blockSize);
  const from = headerSize + block * blockLength;
  const to = Math.min(
    headerSize + (lastBlock + 1) * blockLength,
    Number(total),
  ) - 1;
  init.headers.set("Range", `bytes=${from}-${to}`);
  const second = await fetch(target, init);
  if (!second.ok) {
    await second.body?.cancel();
    return new Response(null, { status: 502 });
  }
  // A remote that sends all the file sends the blocks before the range too.
  let data = second.body;
  if (second.status !== 206) data = sliceStream(data, from, to - from + 1);
  const body = sliceStream(
    data.pipeThrough(decrypt({ nonce, block })),
    start - block * blockSize,
    length,
  );

  if (range) {
    for (const [name, value] of Object.entries(partialHeaders(range, size))) {
      result.set(name, value);
    }
  } else {
    result.set("Content-Length", `${size}`);
  }
  return new Response(sized(body, length), {
    status: range ? 206 : 200,
    headers: result,
  });
}

/**
 * Gives the list of a folder with the names, the sizes and the types of the
 * files, from the list of the encrypted folder on the remote.
 *
 * Each link gets the query of the request with no secret option, and no
 * option of the remote. A name that does not decrypt is not in the list, as
 * rclone skips such a name.
 * @param {Response} response The list of the encrypted folder.
 * @param {{ names: import("./PathCipher.js").PathCipher }} cipher
 * @param {URLSearchParams} searchParams
 * @returns {Promise<Response>}
 */
async function listing(response, { names }, searchParams) {
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.set("Content-Type", "text/html;charset=utf-8");
  // The answer to HEAD has no body.
  if (response.body === null) {
    return new Response(null, { status: response.status, headers });
  }

  const query = new URLSearchParams(searchParams);
  for (const name of SECRETS) query.delete(name);

  // The links of the list are relative to the encrypted folder.
  const encrypted = await readListing(
    response,
    new URL("http://remote/folder/"),
  );
  /** @type {import("@rfetch/lib/listing").Entry[]} */
  const entries = [];
  for (const { Name, IsDir, Size, ModTime } of encrypted) {
    let name;
    try {
      if (Name.includes("/")) continue;
      name = names.decryptName(Name);
    } catch {
      continue;
    }
    entries.push({
      Name: name,
      IsDir,
      Size: IsDir ? -1 : sizeOf(Size < 0 ? null : String(Size)),
      MimeType: IsDir ? "" : mimeType(name),
      ModTime,
    });
  }

  return new Response(renderListing(entries, { query: `${query}` }), {
    status: response.status,
    headers,
  });
}

/**
 * The size of a file from the size of its encrypted data, or -1 for no size
 * or a size that no encrypted data has.
 * @param {string | null} value
 * @returns {number}
 */
function sizeOf(value) {
  if (value === null || !/^\d+$/.test(value)) return -1;
  try {
    return decryptedSize(Number(value), SECRETBOX_OPTIONS);
  } catch {
    return -1;
  }
}

/**
 * Encode the given filename(s)
 *
 * ```js
 * import { encode } from "./main.js";
 * await encode(options, ...arguments);
 * ```
 *
 * This encodes the filenames given as arguments returning a list of strings of
 * the encoded results.
 *
 * Usage Exampe:
 *
 * ```js
 * import { encode } from "./main.js";
 * const response = await encode({password, password2}, file1, file2);
 * await response.text();
 * ```
 *
 * @param {Object} options
 * @param {string} options.password
 * @param {string} options.password2
 * @param {...string} args
 */
export async function encode(options, ...args) {
  const { names } = await cipherOf(options.password, options.password2 ?? "");
  const encoded = args.map((path) => (path ? names.encrypt(path) : "") + "\n");
  return new Response(encoded.join(""));
}

/**
 * Decode the given filename(s)
 *
 * ```js
 * import { decode } from "./main.js";
 * await decode(options, ..arguments);
 * ```
 *
 * This decodes the filenames given as arguments returning a list of strings of
 * the decoded results. It will return an error if any of the inputs are
 * invalid.
 *
 * Usage Example:
 *
 * ```js
 * import { decode } from "./main.js";
 * const response = await decode({password, password2}, encryptedfile1, encryptedfile2);
 * await response.text();
 * ```
 *
 * @param {Object} options
 * @param {string} options.password
 * @param {string} options.password2
 * @param {...string} args
 */
export async function decode(options, ...args) {
  const { names } = await cipherOf(options.password, options.password2 ?? "");
  const decoded = args.map((arg) => (arg ? names.decrypt(arg) : "") + "\n");
  return new Response(decoded.join(""));
}

/**
 * Makes the keys from a password and a salt, as `Cipher.Key` of rclone: 32
 * bytes for the data, 32 bytes for the names, and 16 bytes of tweak for the
 * names. An empty password gives keys of zero bytes.
 * @param {string | Uint8Array} password The password, not obscured.
 * @param {string | Uint8Array} [salt] The salt, not obscured. An empty salt
 *   is the salt of rclone.
 * @returns {Promise<Uint8Array>}
 */
export async function deriveKey(password, salt = "") {
  const bytes = (text) =>
    typeof text === "string" ? encoder.encode(text) : text;
  if (bytes(password).length === 0) {
    return new Uint8Array(dkLen);
  }
  const saltBytes = bytes(salt).length ? bytes(salt) : DEFAULT_SALT;
  // The scrypt of node:crypto is native code, also in a Worker: it is about
  // 4 times faster than scrypt in JavaScript there.
  const key = await new Promise((resolve, reject) => {
    scrypt(
      bytes(password),
      saltBytes,
      dkLen,
      { N, r, p, maxmem: SCRYPT_MEMORY },
      (error, key) => error ? reject(error) : resolve(key),
    );
  });
  return new Uint8Array(key.buffer, key.byteOffset, key.length);
}

/**
 * The ciphers of the last passwords. scrypt takes much time, thus each
 * request does not make the keys again.
 * @type {Map<string, Promise<{ dataKey: Uint8Array, names: import("./PathCipher.js").PathCipher }>>}
 */
const ciphers = new Map();
const MAX_CIPHERS = 16;

/**
 * Gives the key of the data and the cipher of the names for an obscured
 * password and an obscured salt.
 * @param {string} password
 * @param {string} salt "" for the salt of rclone.
 * @throws {Error} When the password or the salt is not obscured.
 */
function cipherOf(password, salt) {
  const id = JSON.stringify([password, salt]);
  let cipher = ciphers.get(id);
  if (cipher) {
    // The last used cipher goes to the end.
    ciphers.delete(id);
  } else {
    cipher = (async () => {
      const key = await deriveKey(
        await revealBytes(password),
        salt ? await revealBytes(salt) : "",
      );
      return {
        dataKey: key.subarray(0, 32),
        names: PathCipher({
          nameKey: key.subarray(32, 64),
          nameTweak: key.subarray(64),
        }),
      };
    })();
    cipher.catch(() => ciphers.delete(id));
  }
  ciphers.set(id, cipher);
  if (ciphers.size > MAX_CIPHERS) {
    ciphers.delete(ciphers.keys().next().value);
  }
  return cipher;
}

/**
 * @param {string} obscured
 * @returns {Promise<Uint8Array>}
 */
async function revealBytes(obscured) {
  const response = await reveal(obscured);
  return new Uint8Array(await response.arrayBuffer());
}

export default {
  fetch: crypt,
};
