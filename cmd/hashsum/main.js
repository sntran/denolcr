/**
 * The sums of the files, as `rclone hashsum`, `rclone md5sum` and `rclone
 * sha1sum`. The backends of rfetch give no hash: thus the commands read each
 * file and compute its hash, as `--download` of rclone.
 */
import { createHash } from "node:crypto";
import { crc32 } from "@rfetch/lib/crc32";
import { isTrue } from "@rfetch/lib/options";

import { fetch } from "../../fetch.js";
import {
  each,
  failure,
  nameOf,
  numberOf,
  OperationError,
  stat,
  walk,
  withFlags,
} from "../operations.js";

/**
 * The hashes of rfetch, by their names in rclone. The name of `node:crypto`,
 * or null for CRC-32.
 * @type {Record<string, string | null>}
 */
const HASHES = {
  md5: "md5",
  sha1: "sha1",
  crc32: null,
  sha256: "sha256",
  sha512: "sha512",
};

/**
 * Gives the name of a hash in rclone, for a name of a person: for example
 * `MD5`, `SHA-1` or `sha256`.
 * @param {string} name
 * @returns {string | null} null for a hash that rfetch does not know.
 */
export function hashName(name) {
  const key = `${name}`.toLowerCase().replaceAll("-", "");
  return Object.hasOwn(HASHES, key) ? key : null;
}

/**
 * Computes the hash of a stream.
 * @param {ReadableStream<Uint8Array>} stream
 * @param {string} type A name of `hashName`.
 * @param {boolean} [base64] Gives the hash in base64, not in hexadecimal.
 * @returns {Promise<string>}
 */
export async function hashStream(stream, type, base64 = false) {
  /** @type {Uint8Array} */
  let bytes;
  if (HASHES[type] === null) {
    let crc = 0;
    for await (const chunk of stream) crc = crc32(chunk, crc);
    bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, crc);
  } else {
    const hash = createHash(HASHES[type]);
    for await (const chunk of stream) hash.update(chunk);
    bytes = hash.digest();
  }
  return Buffer.from(bytes).toString(base64 ? "base64" : "hex");
}

/**
 * Computes the hash of a file of a remote.
 * @param {string} location
 * @param {string} type
 * @param {Object} flags With `base64`.
 * @returns {Promise<string>}
 * @throws {OperationError} When the remote gives an error.
 */
export async function hashFile(location, type, flags = {}) {
  const response = await fetch(withFlags(location, flags));
  if (!response.ok) {
    await response.body?.cancel();
    throw new OperationError(
      `${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }
  return await hashStream(
    response.body ?? new Blob([]).stream(),
    type,
    isTrue(flags.base64),
  );
}

/**
 * Produces a hashsum file for all the objects in the path, as `rclone
 * hashsum`: a line for each file, with its hash, two spaces and its path.
 * With no hash type, it gives the hashes that rfetch knows.
 *
 * The flags of rclone: `--base64`, `--output-file` (the location of a file
 * for the lines), `--checkfile` (the location of a sum file to check the
 * files with, as `checksum` with `--combined -`) and `--download` (always,
 * in rfetch).
 *
 * ```js
 * import { hashsum } from "./main.js";
 * await hashsum("SHA-256", "remote:path");
 * ```
 * @param {string | Object} [type]
 * @param {string | Object} [location]
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function hashsum(type, location, flags = {}) {
  if (typeof type !== "string") {
    return new Response(
      `Supported hashes are:\n${
        Object.keys(HASHES).map((name) => `- ${name}\n`).join("")
      }`,
    );
  }
  if (typeof location !== "string") {
    return new Response("Command hashsum needs 2 arguments", { status: 400 });
  }
  const name = hashName(type);
  if (!name) {
    return new Response(
      `${type}: hash type is not supported, use one of: ${
        Object.keys(HASHES).join(", ")
      }`,
      { status: 400 },
    );
  }
  return await sums(name, location, flags);
}

/**
 * Produces an md5sum file for all the objects in the path, as `rclone
 * md5sum`.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export function md5sum(location, flags = {}) {
  return sums("md5", location, flags);
}

/**
 * Produces an sha1sum file for all the objects in the path, as `rclone
 * sha1sum`.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export function sha1sum(location, flags = {}) {
  return sums("sha1", location, flags);
}

/**
 * Gives the sums of the files of a path.
 * @param {string} type
 * @param {string} location
 * @param {Object} flags
 * @returns {Promise<Response>}
 */
async function sums(type, location, flags) {
  if (typeof flags.checkfile === "string") {
    // As rclone: the list of the check goes to the output.
    const { checksum } = await import("../check/main.js");
    return checksum(type, flags.checkfile, location, {
      combined: "-",
      ...flags,
    });
  }
  try {
    const info = await stat(location, flags);
    if (!info) throw new OperationError("directory not found", 404);
    /** @type {{ path: string, location: string }[]} */
    const files = [];
    if (info.isDir) {
      for await (const item of await walk(location, flags)) {
        if (!item.IsDir) {
          files.push({ path: item.Path, location: item.location });
        }
      }
    } else {
      files.push({ path: nameOf(location), location });
    }
    let text = "";
    let errors = 0;
    let last = "";
    await each(files, numberOf(flags.checkers, 8), async (file) => {
      try {
        // The hash first: else `text` is the text before the wait.
        const hash = await hashFile(file.location, type, flags);
        text += `${hash}  ${file.path}\n`;
      } catch (error) {
        errors++;
        last = error.message;
        // As rclone: the line of a file that fails has the error.
        text += `${"ERROR".padEnd(type === "crc32" ? 8 : 32)}  ${file.path}\n`;
      }
    });
    if (typeof flags.output_file === "string") {
      const response = await fetch(flags.output_file, {
        method: "PUT",
        headers: {
          "Content-Length": `${new TextEncoder().encode(text).length}`,
        },
        body: text,
      });
      await response.body?.cancel();
      if (!response.ok) {
        throw new OperationError(
          `failed to write the output file: ${response.status}`,
          response.status,
        );
      }
      text = "";
    }
    if (errors) {
      return new Response(text, {
        status: 500,
        statusText: `failed to hash ${errors} files: last error was: ${last}`,
      });
    }
    return new Response(text);
  } catch (error) {
    return failure(error);
  }
}
