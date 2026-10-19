import { isTrue } from "@rfetch/lib/options";

import { failure, nameOf, OperationError, stat, walk } from "../operations.js";

/**
 * A file or a folder of the tree.
 * @typedef {Object} Node
 * @property {string} name
 * @property {string} path The path from the root, with a `/` at the start.
 * @property {boolean} isDir
 * @property {number} size
 * @property {string} modTime
 * @property {Node[]} children
 */

/**
 * List the contents of the remote in a tree like fashion, as `rclone tree`
 * and the `tree` command of Unix:
 *
 * ```text
 * /
 * ├── file1
 * └── subdir
 *     └── file2
 *
 * 1 directories, 2 files
 * ```
 *
 * As rclone, the names that start with `.` are not in the tree, unless
 * `--all`. The flags of rclone: `--all`, `--dirs-only`, `--dirsfirst`,
 * `--full-path`, `--level` (or `--max-depth`), `--modtime`, `--noindent`,
 * `--noreport`, `--quote`, `--size` (with `--human-readable`), `--sort`
 * (name, version, size or mtime), `--sort-modtime` and `--sort-reverse`.
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function tree(location, flags = {}) {
  try {
    const info = await stat(location, flags);
    if (!info) throw new OperationError("directory not found", 404);
    /** @type {Node} */
    const root = {
      name: "/",
      path: "/",
      isDir: true,
      size: -1,
      modTime: "",
      children: [],
    };
    const all = isTrue(flags.all);
    if (!info.isDir) {
      const name = nameOf(location);
      root.children.push({
        name,
        path: `/${name}`,
        isDir: false,
        size: info.size,
        modTime: info.modTime,
        children: [],
      });
    } else {
      const level = Number(flags.level || flags.max_depth || Infinity);
      /** @type {Map<string, Node>} */
      const folders = new Map([["", root]]);
      const items = [];
      for await (
        const item of await walk(location, flags, {
          maxDepth: level > 0 ? level : Infinity,
        })
      ) {
        items.push(item);
      }
      // A folder comes before the files in it in the walk, but a child can
      // come before the node of a folder of the same level.
      for (const item of items) {
        if (!item.IsDir) continue;
        folders.set(item.Path, nodeOf(item));
      }
      for (const item of items) {
        const slash = item.Path.lastIndexOf("/");
        const parent = folders.get(
          slash === -1 ? "" : item.Path.slice(0, slash),
        );
        if (!parent) continue;
        if (!all && item.Name.startsWith(".")) continue;
        if (!all && hidden(item.Path)) continue;
        parent.children.push(
          item.IsDir ? folders.get(item.Path) : nodeOf(item),
        );
      }
    }

    const dirsOnly = isTrue(flags.dirs_only);
    const counts = { dirs: 0, files: 0 };
    prune(root, dirsOnly, counts);
    sortTree(root, flags);
    let text = "";
    print(root, "", flags, (line) => text += line);
    if (!isTrue(flags.noreport)) {
      // As rclone: with no file, the count of the folders is 0 too.
      if (counts.files === 0) counts.dirs = 0;
      text += `\n${counts.dirs} directories${
        dirsOnly ? "" : `, ${counts.files} files`
      }\n`;
    }
    return new Response(text);
  } catch (error) {
    return failure(error);
  }
}

/**
 * Tells if a path has a folder with a name that starts with `.`.
 * @param {string} path
 */
function hidden(path) {
  return path.split("/").some((name) => name.startsWith("."));
}

/**
 * The node of an item of a walk.
 * @param {import("../operations.js").WalkItem} item
 * @returns {Node}
 */
function nodeOf(item) {
  return {
    name: item.Name,
    path: `/${item.Path}`,
    isDir: item.IsDir,
    size: item.Size,
    modTime: item.ModTime ?? "",
    children: [],
  };
}

/**
 * Removes the files for `--dirs-only`, and counts the folders and the files
 * below the root.
 * @param {Node} node
 * @param {boolean} dirsOnly
 * @param {{ dirs: number, files: number }} counts
 */
function prune(node, dirsOnly, counts) {
  if (dirsOnly) node.children = node.children.filter((child) => child.isDir);
  for (const child of node.children) {
    if (child.isDir) {
      counts.dirs++;
      prune(child, dirsOnly, counts);
    } else {
      counts.files++;
    }
  }
}

/**
 * Compares two names as Go compares two strings: by the bytes of UTF-8, that
 * is by the code points.
 * @param {string} a
 * @param {string} b
 */
function compareNames(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < x.length && i < y.length; i++) {
    const difference = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (difference) return difference;
  }
  return x.length - y.length;
}

/**
 * Tells if a name comes before another in the natural order of versions, as
 * `NaturalLess` of the tree package: the numbers by their values.
 * @param {string} a
 * @param {string} b
 */
function naturalLess(a, b) {
  const digit = (c) => c >= "0" && c <= "9";
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const c1 = a[i], c2 = b[j];
    const d1 = digit(c1), d2 = digit(c2);
    if (d1 !== d2) return d1;
    if (!d1) {
      if (c1 !== c2) return c1 < c2;
      i++;
      j++;
      continue;
    }
    while (i < a.length && a[i] === "0") i++;
    while (j < b.length && b[j] === "0") j++;
    const start1 = i, start2 = j;
    while (i < a.length && digit(a[i])) i++;
    while (j < b.length && digit(b[j])) j++;
    const n1 = a.slice(start1, i), n2 = b.slice(start2, j);
    if (n1.length !== n2.length) return n1.length < n2.length;
    if (n1 !== n2) return n1 < n2;
    if (start1 !== start2) return start1 < start2;
  }
  return a.length < b.length;
}

/**
 * Sorts the children of each folder, as the tree package: by name, or by the
 * flags. `--dirsfirst` puts the folders first, and keeps the order of the
 * names in each part.
 * @param {Node} node
 * @param {Object} flags
 */
function sortTree(node, flags) {
  const sort = `${flags.sort ?? ""}`;
  /** @type {(a: Node, b: Node) => number} */
  let compare;
  const time = (n) => Date.parse(n.modTime) || 0;
  if (isTrue(flags.sort_modtime) || sort === "mtime") {
    compare = (a, b) => time(a) - time(b);
  } else if (isTrue(flags.dirsfirst)) {
    compare = (a, b) => Number(b.isDir) - Number(a.isDir);
  } else if (sort === "version") {
    compare = (a, b) =>
      naturalLess(a.name, b.name) ? -1 : naturalLess(b.name, a.name) ? 1 : 0;
  } else if (sort === "size") {
    compare = (a, b) => a.size - b.size;
  } else {
    compare = (a, b) => compareNames(a.name, b.name);
  }
  const reverse = isTrue(flags.sort_reverse);
  const visit = (node) => {
    // The order of the names before the sort, as the list of rclone.
    node.children.sort((a, b) => compareNames(a.name, b.name));
    node.children.sort((a, b) => reverse ? compare(b, a) : compare(a, b));
    for (const child of node.children) visit(child);
  };
  visit(node);
}

/**
 * Formats a size as the tree package, for `--human-readable`: for example
 * `52`, `64K` or `2.0M`.
 * @param {number} bytes
 */
function formatBytes(bytes) {
  const units = ["K", "M", "G", "T", "P", "E"];
  let unit = "";
  let value = bytes;
  for (let i = units.length; i > 0; i--) {
    const scale = 2 ** (10 * i);
    if (bytes > scale) {
      unit = units[i - 1];
      value = bytes / scale;
      break;
    }
  }
  if (!unit) return `${Math.round(bytes)}`;
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}${unit}`;
}

/**
 * The size of a folder: the sizes of all the files in it.
 * @param {Node} node
 * @returns {number}
 */
function folderSize(node) {
  let total = 0;
  for (const child of node.children) {
    total += child.isDir ? folderSize(child) : Math.max(child.size, 0);
  }
  return total;
}

/**
 * Writes the time of `--modtime`: `Jan 02 15:04` in this year, else
 * `Jan 02  2006`.
 * @param {string} modTime
 */
function formatTime(modTime) {
  const date = new Date(modTime);
  if (isNaN(date.getTime())) return "";
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = `${date.getDate()}`.padStart(2, "0");
  if (date.getFullYear() !== new Date().getFullYear()) {
    return `${month} ${day}  ${date.getFullYear()}`;
  }
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${month} ${day} ${hours}:${minutes}`;
}

/**
 * Writes a node and the nodes in it.
 * @param {Node} node
 * @param {string} indent
 * @param {Object} flags
 * @param {(text: string) => void} write
 */
function print(node, indent, flags, write) {
  const props = [];
  const human = isTrue(flags.human_readable);
  if (isTrue(flags.size)) {
    const bytes = node.isDir ? folderSize(node) : node.size;
    props.push(
      human ? formatBytes(bytes).padStart(4) : `${bytes}`.padStart(11),
    );
  }
  if (!node.isDir && isTrue(flags.modtime)) {
    props.push(formatTime(node.modTime));
  }
  if (props.length) write(`[${props.join(" ")}]  `);
  let name = node.path === "/" || isTrue(flags.full_path)
    ? node.path
    : node.name;
  if (isTrue(flags.quote)) name = `"${name}"`;
  write(`${name}\n`);
  const noIndent = isTrue(flags.noindent);
  node.children.forEach((child, index) => {
    let add = "";
    if (!noIndent) {
      const last = index === node.children.length - 1;
      write(`${indent}${last ? "└── " : "├── "}`);
      add = last ? "    " : "│   ";
    }
    print(child, indent + add, flags, write);
  });
}
