/**
 * The helpers of the tests of the commands, on the memory remote.
 */
import { encodePath } from "@rfetch/lib/path";

import { fetch } from "../fetch.js";
import { logger, walk } from "./operations.js";

/**
 * Puts files in a folder of a remote.
 * @param {string} folder For example `:memory:/test/`.
 * @param {Record<string, string>} files The texts of the files, by path.
 */
export async function putFiles(folder, files) {
  for (const [path, text] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(text);
    const response = await fetch(`${folder}${encodePath(path)}`, {
      method: "PUT",
      headers: { "Content-Length": `${bytes.length}` },
      body: bytes,
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`PUT ${path}: ${response.status}`);
  }
}

/**
 * Gives the texts of the files, and the folders, of a folder of a remote.
 * @param {string} folder
 * @returns {Promise<{ files: Record<string, string>, folders: string[] } | null>}
 *   null when the folder does not exist.
 */
export async function contents(folder) {
  /** @type {Record<string, string>} */
  const files = {};
  const folders = [];
  let items;
  try {
    items = await walk(folder);
  } catch {
    return null;
  }
  for await (const item of items) {
    if (item.IsDir) {
      folders.push(item.Path);
    } else {
      files[item.Path] = await (await fetch(item.location)).text();
    }
  }
  return { files, folders: folders.sort() };
}

/**
 * Keeps the lines of the log of the commands during a test.
 * @param {import("node:test").TestContext} t
 * @returns {string[]} The lines, with no time.
 */
export function captureLog(t) {
  /** @type {string[]} */
  const lines = [];
  t.mock.method(logger, "write", (line) => {
    lines.push(line.replace(/^\S+ \S+ /, "").trimEnd());
  });
  return lines;
}
