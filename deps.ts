export { parse as parseFlags } from "$std/flags/mod.ts";
export { extname, join, sep } from "$std/path/mod.ts";
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
