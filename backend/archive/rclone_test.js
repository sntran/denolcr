/**
 * The tests of archive against rclone: the lists and the reads of zip
 * files on local folders must be the same in rfetch and in rclone. The zip
 * files come from the command `zip` and from the writer of the tests, for
 * ZIP64, data before the zip file and the times of the extra fields. The
 * tests run when rclone is in the PATH, or when RCLONE is the path of
 * rclone.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

// Sets the global `fetch` that reads the paths of remotes.
import { fetch, lsjson } from "../../mod.js";
import { extendedTime, ntfsTime, zipFile } from "./testing.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;
const hasZip = spawnSync("zip", ["-v"]).status === 0;

/** The text of a size, that compresses. @param {number} size */
function text(size) {
  let value = "";
  for (let line = 0; value.length < size; line++) {
    value += `line ${line} of some text\n`;
  }
  return Buffer.from(value.slice(0, size));
}

/** The files of the zip files, with their content. */
const FILES = {
  "a.txt": Buffer.from("hello\n"),
  "empty.txt": Buffer.alloc(0),
  "dir/large.txt": text(1_500_000),
  "dir/random.bin": randomBytes(70_000),
  "dir/sub/deep.txt": text(3000),
  [`hello? sausage/êé/Hello, 世界/ " ' @ < > & + ≠/z.txt`]: text(100),
};

/** The ranges to read in dir/large.txt. */
const RANGES = [[0, 99], [65_530, 65_545], [1_000_000, 1_499_999]];

describe("archive and rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-archive-"));
  after(() => rmSync(folder, { recursive: true, force: true }));
  const source = join(folder, "source");
  const root = join(folder, "root");
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), content);
  }
  mkdirSync(join(root, "plain folder"), { recursive: true });
  writeFileSync(join(root, "plain folder", "note.txt"), "not in a zip\n");

  const time = new Date(Date.UTC(2022, 1, 3, 4, 5, 6));
  /** The zip files of the writer. */
  const written = Object.entries(FILES).map(([name, data], index) => ({
    name,
    data,
    method: index % 2 ? 0 : 8,
    time,
  }));
  const archives = {
    "written.zip": zipFile([{ name: "dir/", time }, ...written]),
    "zip64.zip": zipFile(written, { zip64: true }),
    "prefix.zip": zipFile(written, { prefix: text(4321), comment: "comment" }),
    "times.zip": zipFile([
      { name: "extended.txt", data: "a", extra: extendedTime(time) },
      {
        name: "ntfs.txt",
        data: "b",
        extra: ntfsTime(
          (BigInt(time.getTime()) / 1000n + 11_644_473_600n) * 10_000_000n +
            7_654_321n,
        ),
      },
    ]),
    "unsafe.zip": zipFile([
      { name: "../evil.txt", data: "x" },
      { name: "./good/./file.txt", data: "y" },
    ]),
  };
  for (const [name, zip] of Object.entries(archives)) {
    writeFileSync(join(root, name), zip);
  }
  if (hasZip) {
    // Deflate, Store, and the files with no compression in a zip file of
    // the command.
    for (const [name, args] of [["command.zip", []], ["stored.zip", ["-0"]]]) {
      const done = spawnSync("zip", [
        "-q",
        "-r",
        ...args,
        join(root, name),
        ".",
      ], {
        cwd: source,
      });
      assert.equal(done.status, 0, `${done.stderr}`);
    }
  }

  /** @param {string[]} args */
  function rclone(...args) {
    return spawnSync(RCLONE, ["--config", join(folder, "none.conf"), ...args], {
      env: { PATH: process.env.PATH, HOME: folder, TZ: "UTC" },
      maxBuffer: 1 << 26,
    });
  }

  /**
   * The entries of a list, to compare: the times of the folders that are
   * not in the index are the time of the list, and rfetch gives -1 for the
   * size of a local folder.
   * @param {Array<Record<string, unknown>>} items
   */
  function comparable(items) {
    return items.map(({ Path, Size, ModTime, IsDir, MimeType }) => ({
      Path,
      Size: IsDir ? -1 : Size,
      Time: IsDir ? 0 : Date.parse(ModTime),
      IsDir,
      MimeType,
    })).sort((a, b) => a.Path < b.Path ? -1 : a.Path > b.Path ? 1 : 0);
  }

  const remote = `:archive:${root}`;

  test("rfetch lists the zip files as rclone", async () => {
    const expected = rclone("lsjson", "-R", remote);
    assert.equal(expected.status, 0, `${expected.stderr}`);
    const response = await lsjson(remote, { recursive: true });
    assert.equal(response.status, 200);
    assert.deepEqual(
      comparable(await response.json()),
      comparable(JSON.parse(expected.stdout)),
    );
  });

  test("rfetch reads the files of the zip files as rclone", async () => {
    const listed = rclone("lsjson", "-R", "--files-only", remote);
    assert.equal(listed.status, 0, `${listed.stderr}`);
    const paths = JSON.parse(listed.stdout).map(({ Path }) => Path);
    assert.ok(paths.length > 20);
    for (const path of paths) {
      const cat = rclone("cat", `${remote}/${path}`);
      assert.equal(cat.status, 0, `${path}: ${cat.stderr}`);
      const location = `${remote}/${
        path.split("/").map(encodeURIComponent).join("/")
      }`;
      const response = await fetch(location);
      assert.equal(response.status, 200, path);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        cat.stdout,
        path,
      );
    }
  });

  test("rfetch reads the ranges of a file as rclone", async () => {
    const names = ["written.zip", "zip64.zip", "prefix.zip"];
    if (hasZip) names.push("command.zip", "stored.zip");
    for (const name of names) {
      for (const [start, end] of RANGES) {
        const cat = rclone(
          "cat",
          "--offset",
          `${start}`,
          "--count",
          `${end - start + 1}`,
          `${remote}/${name}/dir/large.txt`,
        );
        assert.equal(cat.status, 0, `${cat.stderr}`);
        const response = await fetch(`${remote}/${name}/dir/large.txt`, {
          headers: { Range: `bytes=${start}-${end}` },
        });
        assert.equal(response.status, 206);
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          cat.stdout,
          `${name} ${start}-${end}`,
        );
        assert.deepEqual(
          cat.stdout,
          FILES["dir/large.txt"].subarray(start, end + 1),
        );
      }
    }
  });
});
