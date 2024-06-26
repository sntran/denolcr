export { parseArgs } from "https://deno.land/std@0.209.0/cli/parse_args.ts";
export * as INI from "https://deno.land/std@0.209.0/ini/mod.ts";
export {
  basename,
  extname,
  join,
  resolve,
} from "https://deno.land/std@0.209.0/path/mod.ts";
export { getCookies } from "https://deno.land/std@0.209.0/http/cookie.ts";
export { contentType } from "https://deno.land/std@0.209.0/media_types/mod.ts";
export { format as formatBytes } from "https://deno.land/std@0.209.0/fmt/bytes.ts";
export { format as formatDuration } from "https://deno.land/std@0.209.0/fmt/duration.ts";

export * as base64url from "https://deno.land/std@0.209.0/encoding/base64url.ts";
export { encodeHex } from "https://deno.land/std@0.209.0/encoding/hex.ts";
import { crypto } from "https://deno.land/std@0.209.0/crypto/mod.ts";

// Polyfills `HTMLRewriter`, which is available on Cloudflare Workers.
// @ts-ignore: `HTMLRewriter` is not part of globalThis.
if (!globalThis.HTMLRewriter) {
  const { HTMLRewriter } = await import(
    "https://esm.sh/@worker-tools/html-rewriter@0.1.0-pre.19/base64"
  );
  // @ts-ignore: `HTMLRewriter` is not part of globalThis.
  globalThis.HTMLRewriter = HTMLRewriter;
}

// @ts-ignore: `HTMLRewriter` is not part of globalThis.
const HTMLRewriter = globalThis.HTMLRewriter;
export { HTMLRewriter };

/**
 * Calculates the hash of a file.
 * @param {string} path
 * @param {import("https://deno.land/std@0.209.0/crypto/_wasm/mod.ts").DigestAlgorithm} [algorithm="MD5"]
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
  switch (Deno.build.os) {
    case "linux":
    case "darwin": {
      const xdg = Deno.env.get("XDG_CONFIG_HOME");
      if (xdg) return xdg;

      const home = Deno.env.get("HOME");
      if (home) return `${home}/.config`;
      break;
    }

    case "windows":
      return Deno.env.get("APPDATA") ?? null;
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
