#!/usr/bin/env -S deno serve --allow-all

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

import { scrypt } from "https://deno.land/x/scrypto@v1.0.0/scrypt.ts";
import { contentType, extname } from "../../deps.js";
import { fetch } from "../../main.js";
import { reveal } from "../../cmd/obscure/main.js";
import PathCipher from "./PathCipher.js";
import { DecryptionStream, EncryptionStream } from "./secretbox.js";

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
const N = 16384;
const r = 8;
const p = 1;
const keySize = 32 + 32 + 16;

const SECRETBOX_OPTIONS = {
  blockSize: 64 * 1024, // 64 KiB
  magic: encoder.encode("RCLONE\x00\x00"),
};

/**
 * Serves a crypted remote.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function router(request) {
  let { pathname, searchParams } = new URL(request.url);

  let remote = searchParams.get("remote");
  if (!remote) {
    return new Response("Missing remote", { status: 400 });
  }

  remote = remote.replace(/\/$/, "");

  const password = searchParams.get("password");
  const salt = searchParams.get("password2");

  const key = await deriveKey(password, salt);

  const pathCipher = PathCipher({
    nameKey: key.subarray(32, 64),
    nameTweak: key.subarray(64),
  });

  const isDirectory = pathname.endsWith("/");
  pathname = decodeURIComponent(pathname);
  const encryptedPathname = pathCipher.encrypt(pathname);

  const url = remote.replace(/\/$/, "") + encryptedPathname;

  // Encrypts upload body if any.
  if (request.body) {
    request = new Request(request, {
      body: request.body.pipeThrough(
        new EncryptionStream(key.subarray(0, 32), SECRETBOX_OPTIONS),
      ),
    });
  }

  // Delegates to the underlying remote.
  const requestHeaders = new Headers(request.headers);
  // Encrypted data on underlying remote won't respond to range.
  requestHeaders.delete("Range");
  request = new Request(request, {
    headers: requestHeaders,
  });

  let response = await fetch(url, request);
  let { status, statusText, headers, body } = response;
  headers = new Headers(headers);

  const mimetype = contentType(extname(pathname)) || "";
  if (mimetype) {
    headers.set("Content-Type", mimetype);
  }

  if (body) {
    let contentLength = Number(headers.get("Content-Length"));
    if (contentLength) { // Adjusts the content length.
      contentLength = DecryptionStream.size(contentLength, SECRETBOX_OPTIONS);
      headers.set("Content-Length", `${contentLength}`);
    }

    if (isDirectory) {
      const rewriter = new HTMLRewriter();
      rewriter.on("tr a[href]", {
        element(element) {
          let href = element.getAttribute("href");
          let type = element.getAttribute("type");

          const { pathname } = new URL(href, "file:");
          let basename = pathname.slice(1);
          if (pathname != "/") {
            basename = pathCipher.decrypt(basename);
            href = `${basename}?${searchParams}`;
            element.setAttribute("href", href);

            // Replaces inner text with original name.
            element.setInnerContent(basename);
          }

          if (type) {
            type = contentType(extname(basename)) || type;
            element.setAttribute("type", type);
          }
        },
      });
      rewriter.on(`tr data[value]`, {
        element(element) {
          const encryptedSize = Number(element.getAttribute("value"));
          const originalSize = DecryptionStream.size(
            encryptedSize,
            SECRETBOX_OPTIONS,
          );
          element.setAttribute("value", `${originalSize}`);
        },
      });

      response = rewriter.transform(response);
      body = response.body;
    } else {
      body = body.pipeThrough(
        new DecryptionStream(key.subarray(0, 32), SECRETBOX_OPTIONS),
      );
    }
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
  const key = await deriveKey(options.password, options.password2);
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
  const key = await deriveKey(options.password, options.password2);
  const pathCipher = PathCipher({
    nameKey: key.slice(32, 64),
    nameTweak: key.slice(64),
  });

  const decoded = args.map((arg) =>
    (arg ? pathCipher.decrypt(arg) : "") + "\n"
  );
  return new Response(decoded.join(""));
}

/**
 * @param {string} encPass
 * @param {string} encSalt
 * @returns {Promise<Uint8Array>}
 */
async function deriveKey(encPass, encSalt) {
  const password = await reveal(encPass).then((r) => r.arrayBuffer()).then(
    (buf) => new Uint8Array(buf),
  );
  const decryptedSalt = await reveal(encSalt).then((r) => r.arrayBuffer()).then(
    (buf) => new Uint8Array(buf),
  );
  const salt = decryptedSalt.length ? decryptedSalt : DEFAULT_SALT;

  const derivedKey = await scrypt(password, salt, N, r, p, keySize);
  return new Uint8Array(derivedKey);
}

export default {
  fetch: router,
};
