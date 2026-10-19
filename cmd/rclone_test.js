/**
 * The tests of the commands against the commands of rclone, on the same
 * local folders: the output, the exit code, and the files after the command.
 * The tests run when rclone is in the PATH, or when RCLONE is the path of
 * rclone.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;
const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "main.js");

/** The files of the tests, with hard names. */
const FILES = {
  "f.txt": "hello",
  "B.txt": "b",
  "é.txt": "e",
  "a/g.txt": "world!",
  "a/b/zero": "",
  "sp ace/#1 & 2?.txt": "name",
  ".hidden/x": "x",
};

/**
 * The files and the folders of a local folder.
 * @param {string} folder
 * @returns {string[]} The paths, with a `/` at the end of a folder, and the
 *   text of each file.
 */
function treeOf(folder) {
  /** @type {string[]} */
  const paths = [];
  /** @param {string} path */
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const name = relative(folder, full);
      if (entry.isDirectory()) {
        paths.push(`${name}/`);
        visit(full);
      } else {
        paths.push(`${name} ${readFileSync(full, "utf8")}`);
      }
    }
  };
  try {
    statSync(folder);
  } catch {
    return ["(none)"];
  }
  visit(folder);
  return paths.sort();
}

describe("the commands and the commands of rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  const home = mkdtempSync(join(tmpdir(), "rfetch-commands-"));
  const source = join(home, "source");

  /**
   * Runs a program in the folder of the tests.
   * @param {string} program
   * @param {string[]} args
   */
  const run = (program, args) => {
    const { status, stdout, stderr } = spawnSync(program, args, {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TZ: "UTC" },
      encoding: "utf8",
    });
    return { status, stdout, stderr };
  };
  /** @param {...string} args */
  const rclone = (...args) => run(RCLONE, args);
  /** @param {...string} args */
  const rfetch = (...args) => run(process.execPath, [MAIN, ...args]);

  before(() => {
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(source, path)), { recursive: true });
      writeFileSync(join(source, path), text);
    }
    mkdirSync(join(source, "empty", "inner"), { recursive: true });
    const password = rclone("obscure", "commands").stdout.trim();
    mkdirSync(join(home, ".config", "rclone"), { recursive: true });
    writeFileSync(
      join(home, ".config", "rclone", "rclone.conf"),
      `[mem]\ntype = memory\n\n[enc]\ntype = crypt\nremote = ${
        join(home, "encrypted")
      }\npassword = ${password}\n`,
    );
  });
  after(() => rmSync(home, { recursive: true, force: true }));

  /**
   * Runs a command with rclone and rfetch, and compares the outputs and
   * the exit codes.
   * @param {string[]} args
   * @param {{ sort?: boolean }} [options] `sort` compares the lines in any
   *   order: rclone writes them as its checks end.
   */
  const same = (args, { sort = false } = {}) => {
    const expected = rclone(...args);
    const actual = rfetch(...args);
    const lines = (text) => sort ? text.split("\n").sort() : text;
    assert.equal(actual.status, expected.status, `${args.join(" ")}: status`);
    assert.deepEqual(
      lines(actual.stdout),
      lines(expected.stdout),
      args.join(" "),
    );
  };

  test("size", () => {
    same(["size", "source"]);
    same(["size", "--json", "source"]);
    same(["size", "source/a/g.txt"]);
    same(["size", "missing"]);
  });

  test("tree", () => {
    same(["tree", "source"]);
    same(["tree", "--dirs-only", "source"]);
    same(["tree", "--level", "1", "source"]);
    same(["tree", "--dirsfirst", "source"]);
    same(["tree", "--noreport", "--all", "source"]);
    same(["tree", "--size", "source"]);
    same(["tree", "source/f.txt"]);
  });

  test("the sums", () => {
    same(["md5sum", "source"], { sort: true });
    same(["sha1sum", "source"], { sort: true });
    same(["hashsum", "sha256", "source"], { sort: true });
    same(["hashsum", "SHA-1", "source"], { sort: true });
    same(["hashsum", "crc32", "source"], { sort: true });
    same(["hashsum", "md5", "--base64", "source/f.txt"]);
    same(["md5sum", "missing"]);
  });

  test("checksum, and hashsum --checkfile", () => {
    writeFileSync(join(home, "MD5SUMS"), rclone("md5sum", "source").stdout);
    same(["checksum", "md5", "MD5SUMS", "source"]);
    same(["md5sum", "--checkfile", "MD5SUMS", "source"], { sort: true });
    writeFileSync(
      join(home, "BAD"),
      "00000000000000000000000000000000  f.txt\n",
    );
    same(["checksum", "md5", "BAD", "source"]);
  });

  test("check", () => {
    cpSync(source, join(home, "other"), { recursive: true });
    rmSync(join(home, "other", "a", "g.txt"));
    writeFileSync(join(home, "other", "extra"), "x");
    writeFileSync(join(home, "other", "B.txt"), "longer");
    same(["check", "source", "other", "--combined", "-"], { sort: true });
    same(["check", "source", "other", "--one-way", "--missing-on-dst", "-"]);
    same(["check", "source", "source"]);
    // Same size, other bytes: rclone sees it with MD5, rfetch with the
    // bytes.
    writeFileSync(join(home, "other", "f.txt"), "HELLO");
    same(["check", "--download", "source", "other", "--differ", "-"], {
      sort: true,
    });
  });

  test("listremotes", () => {
    same(["listremotes"]);
    same(["listremotes", "--long"]);
    same(["listremotes", "--json"]);
  });

  test("cryptdecode of the names of rclone", () => {
    assert.equal(rclone("copy", "source", "enc:").status, 0);
    const names = readdirSync(join(home, "encrypted"));
    same(["cryptdecode", "enc:", ...names, "not-a-name"]);
    same(["cryptdecode", "--reverse", "enc:", "f.txt", "a/g.txt"]);
  });

  /**
   * Runs a command that changes files with rclone and rfetch, each on its
   * own copy of the files, and compares the files after it.
   * @param {(folder: string) => string[]} args The arguments, for a folder.
   * @param {string[]} [only] Other arguments for rclone only.
   */
  const sameEffect = (args, only = []) => {
    const results = [];
    for (
      const [name, tool] of [
        ["by-rclone", (...a) => rclone(...only, ...a)],
        ["by-rfetch", rfetch],
      ]
    ) {
      const folder = join(home, name);
      rmSync(folder, { recursive: true, force: true });
      cpSync(source, join(folder, "source"), { recursive: true });
      const { status } = tool(...args(name));
      results.push({ status, tree: treeOf(folder) });
    }
    assert.deepEqual(results[1], results[0], args("folder").join(" "));
  };

  test("the commands that delete", () => {
    sameEffect((f) => ["delete", `${f}/source`]);
    sameEffect((f) => ["delete", "--rmdirs", `${f}/source`]);
    sameEffect((f) => ["delete", `${f}/source/a/g.txt`]);
    sameEffect((f) => ["deletefile", `${f}/source/f.txt`]);
    sameEffect((f) => ["deletefile", `${f}/source/a`]);
    sameEffect((f) => ["purge", `${f}/source/a`]);
    sameEffect((f) => ["rmdir", `${f}/source/empty/inner`]);
    sameEffect((f) => ["rmdir", `${f}/source/a`]);
    sameEffect((f) => ["rmdirs", `${f}/source`]);
    sameEffect((f) => ["rmdirs", "--leave-root", `${f}/source/empty`]);
    sameEffect((f) => ["delete", "--dry-run", `${f}/source`]);
  });

  test("the commands that copy and move", () => {
    sameEffect((f) => ["copy", `${f}/source`, `${f}/target`]);
    sameEffect((f) => ["copy", `${f}/source/f.txt`, `${f}/target`]);
    sameEffect((f) => ["copyto", `${f}/source/f.txt`, `${f}/target/new.txt`]);
    // rclone moves a folder of a local remote with one rename. rfetch moves
    // each file, as rclone does with no DirMove.
    const noDirMove = ["--disable", "DirMove"];
    sameEffect((f) => ["move", `${f}/source`, `${f}/target`], noDirMove);
    sameEffect((f) => [
      "move",
      "--delete-empty-src-dirs",
      `${f}/source`,
      `${f}/target`,
    ], noDirMove);
    sameEffect((f) => [
      "move",
      "--delete-empty-src-dirs",
      `${f}/source/a`,
      `${f}/target`,
    ], noDirMove);
    sameEffect((f) => ["moveto", `${f}/source/f.txt`, `${f}/source/g.txt`]);
    sameEffect((f) => ["mkdir", `${f}/source/x/y`]);
    sameEffect((f) => ["touch", `${f}/source/new.txt`]);
  });
});
