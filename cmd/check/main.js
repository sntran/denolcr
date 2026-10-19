/**
 * The checks of files, as `rclone check`, `rclone checksum` and `rclone
 * cryptcheck`. Each problem is an error in the log, and the summary is in
 * notices, as rclone. The lists of the flags `--combined`, `--match`,
 * `--differ`, `--missing-on-src`, `--missing-on-dst` and `--error` go to the
 * location of the flag, or to the output for `-`:
 *
 * - `= path`: the file is the same in the two places.
 * - `- path`: the file is only in the destination.
 * - `+ path`: the file is only in the source.
 * - `* path`: the files differ.
 * - `! path`: the check had an error.
 */
import { isTrue } from "@rfetch/lib/options";

import { fetch } from "../../fetch.js";
import { hashFile, hashName } from "../hashsum/main.js";
import {
  each,
  failure,
  log,
  nameOf,
  numberOf,
  OperationError,
  remoteOf,
  stat,
  walk,
  withFlags,
} from "../operations.js";

/** The flags of the lists, and the sign of each list in `--combined`. */
const REPORTS = {
  match: "=",
  differ: "*",
  missing_on_src: "-",
  missing_on_dst: "+",
  error: "!",
};

/**
 * The results of a check.
 */
class Results {
  differences = 0;
  errors = 0;
  matches = 0;
  noHashes = 0;
  missingOnDst = 0;
  missingOnSrc = 0;
  /** @type {Record<string, string[]>} */
  lists = {
    combined: [],
    ...Object.fromEntries(Object.keys(REPORTS).map((k) => [k, []])),
  };

  /**
   * Adds a path to a list, and to the combined list.
   * @param {keyof typeof REPORTS} kind
   * @param {string} path
   */
  report(kind, path) {
    this.lists[kind].push(path);
    this.lists.combined.push(`${REPORTS[kind]} ${path}`);
  }
}

/**
 * The files of a location: a file, or the files in a folder.
 * @param {string} location
 * @param {Object} flags
 * @returns {Promise<Map<string, { location: string, size: number }>>}
 * @throws {OperationError} With 404 when the location does not exist.
 */
async function filesOf(location, flags) {
  const info = await stat(location, flags);
  if (!info) throw new OperationError("directory not found", 404);
  /** @type {Map<string, { location: string, size: number }>} */
  const files = new Map();
  if (!info.isDir) {
    files.set(nameOf(location), { location, size: info.size });
    return files;
  }
  for await (const item of await walk(location, flags)) {
    if (!item.IsDir) {
      files.set(item.Path, { location: item.location, size: item.Size });
    }
  }
  return files;
}

/**
 * Checks the files in the source and destination match, as `rclone check`.
 * It compares the sizes. The backends of rfetch give no hash, thus as rclone
 * with no common hash, the files with the same size match, and the hashes
 * could not be checked. With `--download`, it reads the files and compares
 * their bytes. With `--one-way`, it does not check the files that are only
 * in the destination.
 *
 * ```js
 * import { check } from "./main.js";
 * await check("source:path", "dest:path", { download: true });
 * ```
 * @param {string} source
 * @param {string} target
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function check(source, target, flags = {}) {
  return await compare(source, target, flags, isTrue(flags.download));
}

/**
 * Checks the integrity of an encrypted remote, as `rclone cryptcheck`: the
 * files of the source, and the files of the crypt remote. rfetch reads and
 * decrypts each file of the crypt remote, and compares its bytes with the
 * source file.
 * @param {string} source
 * @param {string} target A crypt remote.
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function cryptcheck(source, target, flags = {}) {
  try {
    const { type } = await remoteOf(target, flags);
    if (type !== "crypt") {
      throw new OperationError(
        `${target} is not a crypt remote`,
        400,
      );
    }
  } catch (error) {
    return failure(error);
  }
  return await compare(source, target, flags, true);
}

/**
 * Compares the files of two places.
 * @param {string} source
 * @param {string} target
 * @param {Object} flags
 * @param {boolean} download Compares the bytes of the files.
 * @returns {Promise<Response>}
 */
async function compare(source, target, flags, download) {
  try {
    const [sources, targets] = await Promise.all([
      filesOf(source, flags),
      filesOf(target, flags),
    ]);
    const results = new Results();
    const paths = [...new Set([...sources.keys(), ...targets.keys()])].sort();
    const both = [];
    for (const path of paths) {
      const src = sources.get(path);
      const dst = targets.get(path);
      if (src && !dst) {
        log("ERROR", path, `file not in ${target}`, flags);
        results.differences++;
        results.errors++;
        results.missingOnDst++;
        results.report("missing_on_dst", path);
      } else if (!src && dst) {
        if (isTrue(flags.one_way)) continue;
        log("ERROR", path, `file not in ${source}`, flags);
        results.differences++;
        results.errors++;
        results.missingOnSrc++;
        results.report("missing_on_src", path);
      } else if (src && dst) {
        both.push({ path, src, dst });
      }
    }
    await each(
      both,
      numberOf(flags.checkers, 8),
      async ({ path, src, dst }) => {
        if (src.size >= 0 && dst.size >= 0 && src.size !== dst.size) {
          log("ERROR", path, "sizes differ", flags);
          results.differences++;
          results.errors++;
          results.report("differ", path);
          return;
        }
        if (!download) {
          results.noHashes++;
          results.matches++;
          results.report("match", path);
          return;
        }
        try {
          if (await sameBytes(src.location, dst.location, flags)) {
            results.matches++;
            results.report("match", path);
          } else {
            log("ERROR", path, "contents differ", flags);
            results.differences++;
            results.errors++;
            results.report("differ", path);
          }
        } catch (error) {
          log("ERROR", path, `failed to download: ${error.message}`, flags);
          results.errors++;
          results.report("error", path);
        }
      },
    );
    return await summary(results, source, target, flags, "files");
  } catch (error) {
    return failure(error);
  }
}

/**
 * Tells if two files have the same bytes.
 * @param {string} a
 * @param {string} b
 * @param {Object} flags
 */
async function sameBytes(a, b, flags) {
  const [first, second] = await Promise.all([
    hashFile(a, "sha256", flags),
    hashFile(b, "sha256", flags),
  ]);
  return first === second;
}

/**
 * Logs the summary of a check, writes its lists, and gives the answer: an
 * error when there are differences.
 * @param {Results} results
 * @param {string} source
 * @param {string} target
 * @param {Object} flags
 * @param {"files" | "hashes"} missing What the source does not have.
 * @returns {Promise<Response>}
 */
async function summary(results, source, target, flags, missing) {
  if (results.missingOnDst) {
    log("NOTICE", target, `${results.missingOnDst} files missing`, flags);
  }
  if (results.missingOnSrc) {
    // As rclone: a sum file is not a place of files.
    log(
      "NOTICE",
      missing === "hashes" ? "" : source,
      `${results.missingOnSrc} ${missing} missing`,
      flags,
    );
  }
  log("NOTICE", target, `${results.differences} differences found`, flags);
  if (results.errors) {
    log("NOTICE", target, `${results.errors} errors while checking`, flags);
  }
  if (results.noHashes) {
    log(
      "NOTICE",
      target,
      `${results.noHashes} hashes could not be checked`,
      flags,
    );
  }
  if (results.matches) {
    log("NOTICE", target, `${results.matches} matching files`, flags);
  }

  let output = "";
  for (const kind of ["combined", ...Object.keys(REPORTS)]) {
    const where = flags[kind];
    if (typeof where !== "string") continue;
    const text = results.lists[kind].map((line) => `${line}\n`).join("");
    if (where === "-") {
      output += text;
      continue;
    }
    const response = await fetch(where, {
      method: "PUT",
      headers: { "Content-Length": `${new TextEncoder().encode(text).length}` },
      body: text,
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw new OperationError(
        `failed to write ${where}: ${response.status}`,
        response.status,
      );
    }
  }
  // The lists go to the output, and the error to the error output.
  if (results.differences) {
    return new Response(output, {
      status: 500,
      statusText: `${results.differences} differences found`,
    });
  }
  if (results.errors) {
    return new Response(output, {
      status: 500,
      statusText: `${results.errors} errors while checking`,
    });
  }
  return new Response(output);
}

/**
 * Reads a sum file, as `ParseSumFile` of rclone: on each line, a hash, a
 * space, a space or a `*`, and a path.
 * @param {string} text
 * @param {string} name The name of the sum file, for the log.
 * @param {Object} flags
 * @returns {Map<string, string>}
 */
export function parseSums(text, name, flags = {}) {
  /** @type {Map<string, string>} */
  const sums = new Map();
  let warnings = 0;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, number) => {
    if (line === "") return;
    const match = line.match(/^([^ ]+) [ *](.+)$/);
    if (!match) {
      if (++warnings <= 3) {
        log(
          "NOTICE",
          name,
          `improperly formatted checksum line ${number}`,
          flags,
        );
      }
      return;
    }
    const [, sum, file] = match;
    if (sums.has(file)) {
      if (++warnings <= 3) {
        log("NOTICE", name, `duplicate file on checksum line ${number}`, flags);
      }
      return;
    }
    sums.set(file, sum.toLowerCase());
  });
  if (warnings > 3) {
    log("NOTICE", name, `${warnings - 3} warning(s) suppressed...`, flags);
  }
  return sums;
}

/**
 * Checks the files in the destination against a SUM file, as `rclone
 * checksum`. rfetch reads each file to compute its hash, as `--download`
 * of rclone.
 *
 * ```js
 * import { checksum } from "./main.js";
 * await checksum("md5", "/path/to/MD5SUMS", "remote:path");
 * ```
 * @param {string} type The type of the hash, for example `md5` or `SHA-1`.
 * @param {string} sumfile The location of the sum file.
 * @param {string} target
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function checksum(type, sumfile, target, flags = {}) {
  try {
    const name = hashName(type);
    if (!name) {
      throw new OperationError(`${type}: hash type is not supported`, 400);
    }
    const response = await fetch(withFlags(sumfile, flags));
    if (!response.ok) {
      await response.body?.cancel();
      throw new OperationError(
        `cannot open sum file: ${response.status} ${response.statusText}`
          .trim(),
        response.status === 404 ? 404 : 400,
      );
    }
    const sums = parseSums(await response.text(), sumfile, flags);
    const files = await filesOf(target, flags);
    const results = new Results();
    const base64 = isTrue(flags.base64);
    await each(
      [...files].sort(),
      numberOf(flags.checkers, 8),
      async ([path, file]) => {
        const sum = sums.get(path);
        if (sum === undefined) {
          if (isTrue(flags.one_way)) return;
          log("ERROR", path, "sum not found", flags);
          results.differences++;
          results.errors++;
          results.missingOnSrc++;
          results.report("missing_on_src", path);
          return;
        }
        sums.delete(path);
        let hash;
        try {
          hash = await hashFile(file.location, name, { ...flags, base64 });
        } catch (error) {
          log(
            "ERROR",
            path,
            `Failed to calculate hash: ${error.message}`,
            flags,
          );
          results.errors++;
          results.report("error", path);
          return;
        }
        if ((base64 ? hash : hash.toLowerCase()) === sum || hash === sum) {
          results.matches++;
          results.report("match", path);
        } else {
          log("ERROR", path, "files differ", flags);
          results.differences++;
          results.errors++;
          results.report("differ", path);
        }
      },
    );
    for (const path of sums.keys()) {
      log("ERROR", path, `file not in ${target}`, flags);
      results.errors++;
      results.missingOnDst++;
      results.report("missing_on_dst", path);
    }
    return await summary(results, sumfile, target, flags, "hashes");
  } catch (error) {
    return failure(error);
  }
}
