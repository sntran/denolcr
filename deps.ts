export { parse as parseFlags } from "$std/flags/mod.ts";
export { basename, extname, join, resolve } from "$std/path/mod.ts";
export { contentType } from "$std/media_types/mod.ts";

import { crypto } from "$std/crypto/mod.ts";
import { DigestAlgorithm } from "$std/crypto/_wasm/mod.ts";

async function digest(path: string, algorithm: DigestAlgorithm = "MD5") {
  const payload = await Deno.readFile(path);
  const buffer = await crypto.subtle.digest(algorithm, payload);
  const hashArray = Array.from(new Uint8Array(buffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { crypto, digest };

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

/**
 * A TransformStream that slices into chunks of a given size.
 */
export class Chunker extends TransformStream<Uint8Array, Uint8Array> {
  constructor(chunkSize: number) {
    let partialChunk = new Uint8Array(chunkSize);
    let offset = 0;

    function transform(chunk: Uint8Array, controller: TransformStreamDefaultController) {
      let i = 0;

      if (offset > 0) {
        const len = Math.min(chunk.byteLength, chunkSize - offset);
        partialChunk.set(chunk.slice(0, len), offset);
        offset += len;
        i += len;

        if (offset === chunkSize) {
          controller.enqueue(partialChunk);
          partialChunk = new Uint8Array(chunkSize);
          offset = 0;
        }
      }

      while (i < chunk.byteLength) {
        const remainingBytes = chunk.byteLength - i;
        if (remainingBytes >= chunkSize) {
          const record = chunk.slice(i, i + chunkSize);
          i += chunkSize;
          controller.enqueue(record);
          partialChunk = new Uint8Array(chunkSize);
          offset = 0;
        } else {
          const end = chunk.slice(i, i + remainingBytes);
          i += end.byteLength;
          partialChunk.set(end);
          offset = end.byteLength;
        }
      }
    }

    function flush(controller: TransformStreamDefaultController) {
      if (offset > 0) {
        controller.enqueue(partialChunk.slice(0, offset));
      }
    }

    super({
      transform,
      flush,
    });
  }
}
