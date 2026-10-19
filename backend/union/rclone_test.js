/**
 * The tests of union against rclone, on local folders. rclone works on one
 * copy of the folders, and rfetch on another copy: then the files must be
 * the same in the two copies. The tests run when rclone is in the PATH, or
 * when RCLONE is the path of rclone.
 *
 * rclone writes with `rclone rc --loopback`: then the root of the union is
 * the root of the remote, as for rfetch, `rclone serve` and `rclone mount`.
 * A command such as `rclone mkdir union:a/b` makes the union at `a/b`, and
 * then makes `a/b` in each upstream, also in an upstream with `:ro`.
 *
 * The policy `epff` of rclone takes the upstream that answers first, thus
 * the tests cannot compare it. rfetch takes the first upstream in the order
 * of the upstreams, as the documentation of rclone tells.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

// Sets the global `fetch` that reads the paths of remotes.
import { fetch, lsjson } from "../../mod.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

/** The files in the upstreams at the start of each case. */
const FILES = {
  "a/both.txt": "a",
  "b/both.txt": "bb",
  "a/dir/in-a.txt": "x",
  "b/dir/in-b.txt": "yy",
  "b/only-b/f.txt": "z",
  "c/ro.txt": "read only",
  [`b/hello? sausage/êé/Hello, 世界/ " ' @ < > & ? + ≠/z.txt`]: "w",
};

describe("union and rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-union-"));
  after(() => rmSync(folder, { recursive: true, force: true }));
  let count = 0;
  // The file that rclone puts in the union.
  const source = join(folder, "source");
  mkdirSync(source);
  writeFileSync(join(source, "new.txt"), "new content");

  /**
   * Makes a new copy of the files, and the remote of a union of its
   * folders `a`, `b` and `c`.
   * @param {string} tags The tags of the upstreams, for example
   *   `["", ":nc", ":ro"]`.
   * @param {string} [options] Options of the remote, for example
   *   `create_policy=ff`.
   */
  function copy(tags = ["", "", ":ro"], options = "") {
    const root = join(folder, `${count++}`);
    for (const [path, content] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const upstreams = ["a", "b", "c"].map((name, index) =>
      `"${root}/${name}${tags[index]}"`
    ).join(" ");
    return {
      root,
      remote: `:union,upstreams='${upstreams}'${options ? `,${options}` : ""}:`,
    };
  }

  /**
   * Runs rclone.
   * @param {string[]} args
   * @param {string} [input]
   */
  function rclone(args, input) {
    return spawnSync(RCLONE, ["--config", join(folder, "none.conf"), ...args], {
      env: { PATH: process.env.PATH, HOME: folder },
      encoding: "utf8",
      input,
    });
  }

  /**
   * The files of a copy, with their content.
   * @param {string} root
   * @returns {Record<string, string>}
   */
  function tree(root) {
    /** @type {Record<string, string>} */
    const files = {};
    for (
      const entry of readdirSync(root, { recursive: true, withFileTypes: true })
    ) {
      const path = join(entry.parentPath, entry.name).slice(root.length + 1);
      files[path] = entry.isFile()
        ? readFileSync(join(root, path), "utf8")
        : "/";
    }
    return files;
  }

  /** @param {Array<Record<string, unknown>>} items */
  function comparable(items) {
    return items.map(({ Path, Name, Size, MimeType, ModTime, IsDir }) => ({
      Path,
      Name,
      // rfetch gives -1 for the size of a folder.
      Size: IsDir ? -1 : Size,
      MimeType,
      ModTime,
      IsDir,
    })).sort((a, b) => a.Path < b.Path ? -1 : a.Path > b.Path ? 1 : 0);
  }

  for (const policy of ["ff", "newest"]) {
    test(`lsjson -R with the search policy ${policy}`, async () => {
      const { remote } = copy(undefined, `search_policy=${policy}`);
      const expected = rclone(["lsjson", "-R", remote]);
      assert.equal(expected.status, 0, expected.stderr);
      const response = await lsjson(remote, { recursive: true });
      assert.equal(response.status, 200);
      assert.deepEqual(
        comparable(await response.json()),
        comparable(JSON.parse(expected.stdout)),
      );
    });
  }

  test("cat reads the file of the search policy", async () => {
    for (const policy of ["ff", "newest"]) {
      const { remote } = copy(undefined, `search_policy=${policy}`);
      const expected = rclone(["cat", `${remote}both.txt`]);
      const response = await fetch(`${remote}both.txt`);
      assert.equal(await response.text(), expected.stdout, policy);
    }
  });

  /**
   * Writes with rclone, with the root of the union at the root of the
   * remote.
   * @param {string} command `put`, `mkdir`, `deletefile` or `purge`.
   * @param {string} remote
   * @param {string} path
   */
  function write(command, remote, path) {
    const args = command === "put"
      ? [
        "operations/copyfile",
        `srcFs=${source}`,
        "srcRemote=new.txt",
        `dstFs=${remote}`,
        `dstRemote=${path}`,
      ]
      : [`operations/${command}`, `fs=${remote}`, `remote=${path}`];
    // With --inplace, rclone changes a file that exists, as a PUT of rfetch:
    // else it writes a new file, then moves it over the file.
    return rclone(["rc", "--loopback", "--inplace", ...args]);
  }

  /**
   * The cases of writes: each puts a file, makes a folder or deletes a file
   * or a folder, with rclone and with rfetch.
   * @type {Array<[string, string, string, (remote: string) => Promise<Response>]>}
   */
  const CASES = [
    ["new file in the root", "put", "new.txt", (r) => put(r, "new.txt")],
    [
      "new file in a folder of b only",
      "put",
      "only-b/new.txt",
      (r) => put(r, "only-b/new.txt"),
    ],
    [
      "new file in a folder that no upstream has",
      "put",
      "new/deep/new.txt",
      (r) => put(r, "new/deep/new.txt"),
    ],
    [
      "change of a file in a and b",
      "put",
      "both.txt",
      (r) => put(r, "both.txt"),
    ],
    [
      "change of a file only in a read only upstream",
      "put",
      "ro.txt",
      (r) => put(r, "ro.txt"),
    ],
    ["new folder", "mkdir", "made/sub", (r) => mkdir(r, "made/sub/")],
    [
      "delete of a file in a and b",
      "deletefile",
      "both.txt",
      (r) => remove(r, "both.txt"),
    ],
    ["delete of a folder", "purge", "dir", (r) => remove(r, "dir/")],
  ];

  /** @param {string} remote @param {string} path */
  function put(remote, path) {
    return fetch(`${remote}${path}`, { method: "PUT", body: "new content" });
  }
  /** @param {string} remote @param {string} path */
  function mkdir(remote, path) {
    return fetch(`${remote}${path}`, { method: "PUT" });
  }
  /** @param {string} remote @param {string} path */
  function remove(remote, path) {
    return fetch(`${remote}${path}`, { method: "DELETE" });
  }

  for (
    const options of [
      "",
      "create_policy=ff",
      "create_policy=epall",
      "create_policy=all",
      "action_policy=all",
    ]
  ) {
    for (const [name, command, path, run] of CASES) {
      test(`${name} (${options || "default policies"})`, async () => {
        const expected = copy(undefined, options);
        const actual = copy(undefined, options);
        const done = write(command, expected.remote, path);
        assert.equal(done.status, 0, done.stderr);
        const response = await run(actual.remote);
        await response.body?.cancel();
        assert.ok(response.ok, `${response.status}`);
        assert.deepEqual(tree(actual.root), tree(expected.root));
      });
    }
  }

  test("rfetch refuses the writes that rclone refuses", async () => {
    for (
      const [tags, command, path, request] of [
        [[":ro", ":ro", ":ro"], "put", "new.txt", (r) => put(r, "new.txt")],
        [
          [":ro", ":ro", ":ro"],
          "deletefile",
          "both.txt",
          (r) => remove(r, "both.txt"),
        ],
        [[":nc", ":nc", ":ro"], "put", "new.txt", (r) => put(r, "new.txt")],
      ]
    ) {
      const expected = copy(tags);
      const actual = copy(tags);
      const done = write(command, expected.remote, path);
      assert.notEqual(done.status, 0);
      assert.match(`${done.stdout}${done.stderr}`, /permission denied/);
      const response = await request(actual.remote);
      assert.equal(response.status, 403);
      assert.equal(await response.text(), "permission denied");
      assert.deepEqual(tree(actual.root), tree(expected.root));
    }
  });

  test("rfetch gives the errors of rclone for the options", async () => {
    const one = join(folder, "one");
    for (
      const options of [
        "upstreams=''",
        `upstreams='${one}'`,
        `upstreams='${one}:writeback ${one}/x:writeback'`,
        `upstreams='${one} ${one}/x',search_policy=nosuch`,
      ]
    ) {
      const location = `:union,${options}:`;
      const { stderr } = rclone(["lsjson", location]);
      const response = await fetch(location);
      assert.equal(response.status, 400, options);
      const message = await response.text();
      assert.ok(
        stderr.includes(`: ${message}\n`),
        `${options}: ${message}\n${stderr}`,
      );
    }
  });
});
