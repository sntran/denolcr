export { parse as parseFlags } from "$std/flags/mod.ts";
export { basename, extname, join, resolve } from "$std/path/mod.ts";
export { contentType } from "$std/media_types/mod.ts";

import { crypto } from "$std/crypto/mod.ts";
import { DigestAlgorithm } from "$std/crypto/_wasm_crypto/mod.ts";

async function digest(path: string, algorithm: DigestAlgorithm = "MD5") {
  const payload = await Deno.readFile(path);
  const buffer = await crypto.subtle.digest(algorithm, payload);
  const hashArray = Array.from(new Uint8Array(buffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { crypto, digest };

export * as INI from "https://esm.sh/ini@3.0.1";

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
