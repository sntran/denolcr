/**
 * The tests of compress against rclone, in the two directions: rfetch reads
 * the files that rclone compresses, and rclone reads the files that rfetch
 * compresses, with the level of rclone by default (0) and the level 6. The
 * tests run when rclone is in the PATH, or when RCLONE is the path of
 * rclone.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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

/** The text of a size, that compresses. @param {number} size */
function text(size) {
  let value = "";
  for (let line = 0; value.length < size; line++) {
    value += `line ${line} of some text\n`;
  }
  return Buffer.from(value.slice(0, size));
}

/** The files, with their content. */
const FILES = {
  // Three blocks of 1 MiB.
  "text.txt": text(2_888_890),
  "random.bin": randomBytes(5000),
  "empty.txt": Buffer.alloc(0),
  "small.txt": Buffer.from("hello hello hello hello hello hello hello hello\n"),
  "dir/nested text.txt": text(200_000),
  [`hello? sausage/êé/Hello, 世界/ " ' @ < > & ? + ≠/z.txt`]: text(3000),
};

/**
 * The location of a path in a remote, with each part of the path encoded.
 * @param {string} remote
 * @param {string} path
 */
function at(remote, path) {
  return remote + path.split("/").map(encodeURIComponent).join("/");
}

/** The ranges to read in text.txt, at the ends of the blocks. */
const RANGES = [
  [0, 99],
  [1_048_570, 1_048_590],
  [2_097_151, 2_097_152],
  [2_500_000, 2_888_889],
];

describe("compress and rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-compress-"));
  after(() => rmSync(folder, { recursive: true, force: true }));
  const source = join(folder, "source");
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), content);
  }

  /** @param {string[]} args */
  function rclone(...args) {
    return spawnSync(RCLONE, ["--config", join(folder, "none.conf"), ...args], {
      env: { PATH: process.env.PATH, HOME: folder },
      maxBuffer: 1 << 26,
    });
  }

  /** The files in a folder, with no time. @param {string} root */
  function names(root) {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
      .sort();
  }

  /** @param {Array<Record<string, unknown>>} items */
  function comparable(items) {
    return items.map(({ Path, Size, ModTime, IsDir }) => ({
      Path,
      // rfetch gives -1 for the size of a local folder.
      Size: IsDir ? -1 : Size,
      ModTime: IsDir ? "" : ModTime,
      IsDir,
    })).sort((a, b) => a.Path < b.Path ? -1 : a.Path > b.Path ? 1 : 0);
  }

  for (const level of ["", "6"]) {
    const options = level ? `,level=${level}` : "";
    const byRclone = join(folder, `rclone${level}`);
    const byRfetch = join(folder, `rfetch${level}`);
    const rcloneRemote = `:compress,remote='${byRclone}'${options}:`;
    const rfetchRemote = `:compress,remote='${byRfetch}'${options}:`;
    const name = level ? `level ${level}` : "the level of rclone";

    test(`rclone and rfetch write the same files (${name})`, async () => {
      const done = rclone("copy", source, rcloneRemote);
      assert.equal(done.status, 0, `${done.stderr}`);
      for (const [path, content] of Object.entries(FILES)) {
        const response = await fetch(at(rfetchRemote, path), {
          method: "PUT",
          body: content,
          headers: { "Content-Length": `${content.length}` },
        });
        assert.equal(response.status, 201, path);
      }
      assert.deepEqual(names(byRfetch), names(byRclone));
      // The metadata tell the same mode, size, hash and type.
      for (const path of Object.keys(FILES)) {
        const ours = JSON.parse(readFileSync(join(byRfetch, `${path}.json`)));
        const theirs = JSON.parse(readFileSync(join(byRclone, `${path}.json`)));
        for (const key of ["Mode", "Size", "MD5", "MimeType"]) {
          assert.equal(ours[key], theirs[key], `${path}: ${key}`);
        }
      }
    });

    test(`rfetch reads the files of rclone (${name})`, async () => {
      const expected = rclone("lsjson", "-R", rcloneRemote);
      assert.equal(expected.status, 0, `${expected.stderr}`);
      const response = await lsjson(rcloneRemote, { recursive: true });
      assert.deepEqual(
        comparable(await response.json()),
        comparable(JSON.parse(expected.stdout)),
      );
      for (const [path, content] of Object.entries(FILES)) {
        const file = await fetch(at(rcloneRemote, path));
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), content, path);
      }
      for (const [start, end] of RANGES) {
        const part = await fetch(`${rcloneRemote}text.txt`, {
          headers: { Range: `bytes=${start}-${end}` },
        });
        assert.equal(part.status, 206);
        assert.deepEqual(
          Buffer.from(await part.arrayBuffer()),
          FILES["text.txt"].subarray(start, end + 1),
          `${start}-${end}`,
        );
      }
    });

    test(`rclone reads the files of rfetch (${name})`, () => {
      const listed = rclone("lsjson", "-R", rfetchRemote);
      assert.equal(listed.status, 0, `${listed.stderr}`);
      const files = JSON.parse(listed.stdout).filter(({ IsDir }) => !IsDir);
      assert.deepEqual(
        files.map(({ Path, Size }) => [Path, Size]).sort(),
        Object.entries(FILES).map(([path, { length }]) => [path, length])
          .sort(),
      );
      for (const [path, content] of Object.entries(FILES)) {
        const cat = rclone("cat", `${rfetchRemote}${path}`);
        assert.equal(cat.status, 0, `${cat.stderr}`);
        assert.deepEqual(cat.stdout, content, path);
      }
      // rclone reads a range from the block of its first byte, with the
      // blocks in the metadata of rfetch.
      for (const [start, end] of RANGES) {
        const cat = rclone(
          "cat",
          "--offset",
          `${start}`,
          "--count",
          `${end - start + 1}`,
          `${rfetchRemote}text.txt`,
        );
        assert.equal(cat.status, 0, `${cat.stderr}`);
        assert.deepEqual(
          cat.stdout,
          FILES["text.txt"].subarray(start, end + 1),
          `${start}-${end}`,
        );
      }
      const sums = rclone("md5sum", rfetchRemote);
      assert.equal(sums.status, 0, `${sums.stderr}`);
      for (const [path, content] of Object.entries(FILES)) {
        const md5 = createHash("md5").update(content).digest("hex");
        assert.ok(`${sums.stdout}`.includes(`${md5}  ${path}\n`), path);
      }
      const check = rclone("check", source, rfetchRemote);
      assert.equal(check.status, 0, `${check.stderr}`);
    });
  }

  test("rclone reads a file that rfetch writes with no Content-Length", async () => {
    const root = join(folder, "stream");
    const remote = `:compress,remote='${root}':`;
    const content = FILES["text.txt"];
    const response = await fetch(`${remote}text.txt`, {
      method: "PUT",
      body: new Blob([content]).stream(),
    });
    assert.equal(response.status, 201);
    const cat = rclone("cat", `${remote}text.txt`);
    assert.deepEqual(cat.stdout, content);
  });
});
