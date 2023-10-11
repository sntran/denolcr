export { parse as parseFlags } from "https://deno.land/std@0.203.0/flags/mod.ts";
export {
  basename,
  extname,
  join,
  resolve,
} from "https://deno.land/std@0.203.0/path/mod.ts";
export { contentType } from "https://deno.land/std@0.203.0/media_types/mod.ts";
export { format as formatBytes } from "https://deno.land/std@0.203.0/fmt/bytes.ts";
export { format as formatDuration } from "https://deno.land/std@0.203.0/fmt/duration.ts";

export * as base64url from "https://deno.land/std@0.203.0/encoding/base64url.ts";

import {
  crypto,
  toHashString,
} from "https://deno.land/std@0.203.0/crypto/mod.ts";
import { DigestAlgorithm } from "https://deno.land/std@0.203.0/crypto/_wasm/mod.ts";

async function digest(path: string, algorithm: DigestAlgorithm = "MD5") {
  const payload = await Deno.readFile(path);
  const buffer = await crypto.subtle.digest(algorithm, payload);
  const hashArray = Array.from(new Uint8Array(buffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { crypto, digest, toHashString };

export * as INI from "https://cdn.skypack.dev/ini@3.0.1";

export function config_dir(): string | null {
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

export function toLocaleISOString(value: string | null) {
  if (!value) return undefined;

  let date = new Date(value);
  const off = date.getTimezoneOffset() * -1;
  const del = date.getMilliseconds() ? "Z" : "."; // have milliseconds ?
  date = new Date(date.getTime() + off * 60000); // add or subtract time zone
  return date
    .toISOString()
    .split(del)[0] +
    (off < 0 ? "-" : "+") +
    ("0" + Math.abs(Math.floor(off / 60))).substr(-2) +
    ":" +
    ("0" + Math.abs(off % 60)).substr(-2);
}

export function mkBuffer(
  sizeInBytes: number,
  fill = crypto.getRandomValues,
): Uint8Array {
  const buffer = new Uint8Array(sizeInBytes);
  const chunkSize = 65536; // maximum chunk size allowed by crypto.getRandomValues()
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.subarray(i, i + chunkSize);
    fill(chunk); // fill the chunk with random values
  }
  return buffer;
}
