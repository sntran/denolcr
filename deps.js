import { platform } from "node:os";
import { env } from "node:process";

export { parseArgs } from "@std/cli/parse-args";
export * as INI from "@std/ini";
export { basename, extname, join, resolve } from "@std/path";
export { getCookies } from "@std/http/cookie";
export { contentType } from "@std/media-types";
export { format as formatBytes } from "@std/fmt/bytes";
export { format as formatDuration } from "@std/fmt/duration";

export { encodeBase64Url, encodeHex } from "@std/encoding";
import { crypto } from "@std/crypto";

export { default as decodeBase32 } from "base32-decode";
export { default as encodeBase32 } from "base32-encode";

import aesjs from "aes-js";
// `aes-js` is a CommonJS module, so we need to use `default` to import it.
const { AES } = aesjs;
export { AES };

export { xsalsa20poly1305 } from "@noble/ciphers/salsa";
export { scryptAsync as scrypt } from "@noble/hashes/scrypt";

// Polyfills `HTMLRewriter`, which is available on Cloudflare Workers.
// @ts-ignore: `HTMLRewriter` is not part of globalThis.
if (!globalThis.HTMLRewriter) {
  const { HTMLRewriter } = await import("@sntran/html-rewriter");
  // @ts-ignore: `HTMLRewriter` is not part of globalThis.
  globalThis.HTMLRewriter = HTMLRewriter;
}

// @ts-ignore: `HTMLRewriter` is not part of globalThis.
const HTMLRewriter = globalThis.HTMLRewriter;
export { HTMLRewriter };

/**
 * Calculates the hash of a file.
 * @param {string} path
 * @param {import("@std/crypto").DigestAlgorithm} [algorithm=""]
 * @returns {string}
 */
async function digest(path, algorithm = "MD5") {
  const payload = await Deno.readFile(path);
  const buffer = await crypto.subtle.digest(algorithm, payload);
  const hashArray = Array.from(new Uint8Array(buffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { crypto, digest };

/**
 * Retrieves the configuration directory for current platform.
 * @returns {string | null}
 */
export function config_dir() {
  switch (platform()) {
    case "linux":
    case "darwin": {
      const xdg = env["XDG_CONFIG_HOME"];
      if (xdg) return xdg;

      const home = env["HOME"];
      if (home) return `${home}/.config`;
      break;
    }

    case "windows":
      return env["APPDATA"] ?? null;
  }

  return null;
}

/**
 * Converts a date string to a locale ISO string.
 * @param {string | null} value
 * @returns {string}
 */
export function toLocaleISOString(value) {
  if (!value) return undefined;

  let date = new Date(value);
  const off = date.getTimezoneOffset() * -1;
  const del = date.getMilliseconds() ? "Z" : "."; // have milliseconds ?
  date = new Date(date.getTime() + off * 60000); // add or subtract time zone
  return date
    .toISOString()
    .split(del)[0] +
    (off < 0 ? "-" : "+") +
    ("0" + Math.abs(Math.floor(off / 60))).substring(-2) +
    ":" +
    ("0" + Math.abs(off % 60)).substring(-2);
}

/**
 * Makes a buffer filled with random values.
 * @param {number} sizeInBytes
 * @param {(Uint8Array) => Uint8Array} fill
 * @returns {Uint8Array}
 */
export function mkBuffer(sizeInBytes, fill = crypto.getRandomValues) {
  const buffer = new Uint8Array(sizeInBytes);
  const chunkSize = 65536; // maximum chunk size allowed by crypto.getRandomValues()
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.subarray(i, i + chunkSize);
    fill(chunk); // fill the chunk with random values
  }
  return buffer;
}
