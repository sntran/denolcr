/**
 * The tests of archive against 7-Zip, which reads RAR, zip and 7z: the
 * lists and the files of rfetch must be the same as the lists and the
 * files of 7-Zip. The archives are the files of testdata and files of the
 * writers of the tests. The tests run when 7-Zip is in the PATH as `7zz`,
 * or when SEVENZIP is the path of 7-Zip.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Sets the global `fetch` that reads the paths of remotes.
import { fetch, lsjson } from "../../mod.js";
import { rar5File, zipFile } from "./testing.js";

const SEVENZIP = process.env.SEVENZIP || "7zz";
const hasSevenZip = spawnSync(SEVENZIP, ["i"]).status === 0;

/** The password of the files of testdata with a password. */
const PASSWORD = "fixture-password";

/**
 * Runs 7-Zip.
 * @param {string[]} args
 */
function sevenZip(...args) {
  return spawnSync(SEVENZIP, args, {
    env: { PATH: process.env.PATH, TZ: "UTC", LC_ALL: "C.UTF-8" },
    maxBuffer: 1 << 26,
  });
}

/**
 * The entries of an archive, as `7zz l -slt` tells them.
 * @param {string} archive
 * @returns {Array<Record<string, string>>}
 */
function listOf(archive) {
  const result = sevenZip("l", "-slt", `-p${PASSWORD}`, archive);
  assert.equal(result.status, 0, `${archive}: ${result.stderr}`);
  const text = `${result.stdout}`;
  const body = text.slice(text.indexOf("\n----------\n") + 12);
  return body.split(/\n\n+/).filter((block) => block.includes("Path = "))
    .map((block) =>
      Object.fromEntries(
        block.split("\n").map((line) => line.split(" = ")).filter((pair) =>
          pair.length === 2
        ),
      )
    );
}

/**
 * Tells if rfetch reads the method of a file: store mode of RAR, Store and
 * Deflate of zip, and Copy, LZMA, LZMA2 and Deflate of 7z, with no filter.
 * @param {string} archive
 * @param {string} method The method of 7-Zip, for example `LZMA2:24k`.
 */
function supported(archive, method) {
  if (archive.endsWith(".rar")) return /^m0\b/.test(method);
  if (archive.endsWith(".zip")) return /^(Store|Deflate)?$/.test(method);
  return method.split(" ").every((part) =>
    /^(Copy|LZMA|LZMA2|Deflate)(:|$)/.test(part)
  );
}

/**
 * Tells if an entry of 7-Zip is a folder: 7-Zip tells it in `Folder` for
 * RAR and zip, and in `Attributes` for 7z.
 * @param {Record<string, string>} entry
 */
function isFolder(entry) {
  return entry.Folder === "+" || /^D/.test(entry.Attributes ?? "");
}

/** @param {string} text A time of 7-Zip, in UTC. */
function secondsOf(text) {
  return Math.floor(
    Date.parse(`${text.slice(0, 19).replace(" ", "T")}Z`) / 1000,
  );
}

describe("archive and 7-Zip", {
  skip: !hasSevenZip &&
    "7-Zip is not installed. Set SEVENZIP to the path of 7zz.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-7zip-"));
  after(() => rmSync(folder, { recursive: true, force: true }));
  const testdata = fileURLToPath(new URL("./testdata/", import.meta.url));
  for (const name of readdirSync(testdata)) {
    if (!name.endsWith(".md")) {
      copyFileSync(join(testdata, name), join(folder, name));
    }
  }
  const big = new Uint8Array(300_000).map((_, index) => index * 7);
  /** @type {Array<{ name: string, data?: Uint8Array | string }>} */
  const files = [{ name: "dir/" }, { name: "dir/a.txt", data: "a" }, {
    name: "big.bin",
    data: big,
  }];
  for (let index = 0; index < 40; index++) {
    files.push({
      name: `many/file${index}.txt`,
      data: "x".repeat(9000 + index),
    });
  }
  writeFileSync(join(folder, "written.rar"), rar5File(files));
  writeFileSync(
    join(folder, "written.zip"),
    zipFile(
      files.map((file, index) => ({ ...file, method: index % 2 ? 0 : 8 })),
    ),
  );
  writeFileSync(
    join(folder, "zip64.zip"),
    zipFile(files.filter(({ name }) => !name.endsWith("/")), { zip64: true }),
  );

  // The 7z files of 7-Zip, with the methods of 7z, from a folder of files.
  const source = join(folder, "source");
  mkdirSync(join(source, "dir", "sub"), { recursive: true });
  mkdirSync(join(source, "empty dir"));
  mkdirSync(join(source, "êé"));
  let text = "";
  for (let line = 0; text.length < 700_000; line++) {
    text += `line ${line} of some text with words ${line * 7 % 1000}\n`;
  }
  writeFileSync(join(source, "dir", "large.txt"), text.slice(0, 700_000));
  writeFileSync(join(source, "random.bin"), randomBytes(300_000));
  writeFileSync(join(source, "empty.txt"), "");
  writeFileSync(join(source, "êé", "Hello, 世界.txt"), "z\n");
  for (let index = 0; index < 50; index++) {
    writeFileSync(
      join(source, "dir", "sub", `small${index}.txt`),
      `file ${index}\n`,
    );
  }
  for (
    const [name, args] of [
      ["copy.7z", ["-mx0"]],
      ["copy-plain.7z", ["-mx0", "-mhc=off"]],
      ["fast.7z", ["-mx1"]],
      ["normal.7z", []],
      ["ultra.7z", ["-mx9"]],
      ["lzma-1.7z", ["-m0=LZMA", "-mx5"]],
      ["deflate-1.7z", ["-m0=Deflate"]],
      ["not-solid.7z", ["-ms=off"]],
      ["blocks.7z", ["-ms=100k"]],
      ["bzip2.7z", ["-m0=BZip2"]],
    ]
  ) {
    const done = sevenZip(
      "a",
      "-bso0",
      ...args,
      join(folder, name),
      `${source}/.`,
    );
    assert.equal(done.status, 0, `${done.stderr}`);
  }

  /**
   * The archives. 7-Zip reads all the volumes of a RAR file, and rfetch
   * reads one volume: the unit tests check the volumes.
   */
  const archives = readdirSync(folder).filter((name) =>
    /\.(rar|zip|7z)$/.test(name) && !/\.part\d+\.rar$/.test(name)
  ).sort();

  test("rfetch lists the archives as 7-Zip", async () => {
    for (const name of archives) {
      // An archive with a password on its headers gives 501.
      if (name.startsWith("headers")) continue;
      const expected = listOf(join(folder, name))
        // A part of a file that starts in a volume before.
        .filter((entry) => entry["Split Before"] !== "+");
      const response = await lsjson(`:archive:${folder}/${name}/`, {
        recursive: true,
      });
      assert.equal(response.status, 200, name);
      const ours = new Map(
        (await response.json()).map((item) => [item.Path, item]),
      );
      for (const entry of expected) {
        const item = ours.get(entry.Path);
        assert.ok(item, `${name}: ${entry.Path}`);
        assert.equal(item.IsDir, isFolder(entry), `${name}: ${entry.Path}`);
        if (!item.IsDir) {
          assert.equal(item.Size, Number(entry.Size), `${name}: ${entry.Path}`);
        }
        if (entry.Modified) {
          assert.equal(
            Math.floor(Date.parse(item.ModTime) / 1000),
            secondsOf(entry.Modified),
            `${name}: ${entry.Path}`,
          );
        }
      }
      // Each file of rfetch is a file of 7-Zip. rfetch also has the folders
      // that are not in the index.
      const paths = new Set(expected.map(({ Path }) => Path));
      for (const [path, item] of ours) {
        if (!item.IsDir) assert.ok(paths.has(path), `${name}: ${path}`);
      }
    }
  });

  /**
   * The folder of the files of an archive, that 7-Zip extracts once.
   * @param {string} name
   */
  function extractedOf(name) {
    const out = join(folder, "extracted", name);
    if (!existsSync(out)) {
      const done = sevenZip(
        "x",
        "-bso0",
        "-y",
        `-p${PASSWORD}`,
        `-o${out}`,
        join(folder, name),
      );
      assert.equal(done.status, 0, `${name}: ${done.stderr}`);
    }
    return out;
  }

  test("rfetch reads the files of the archives as 7-Zip", async () => {
    for (const name of archives) {
      // An archive with a password on its headers gives 501.
      if (name.startsWith("headers")) continue;
      for (const entry of listOf(join(folder, name))) {
        if (isFolder(entry) || entry["Split Before"] === "+") continue;
        const location = `:archive:${folder}/${name}/${
          entry.Path.split("/").map(encodeURIComponent).join("/")
        }`;
        const response = await fetch(location);
        const readable = entry.Encrypted !== "+" &&
          entry["Split After"] !== "+" && supported(name, entry.Method ?? "");
        if (response.status === 501) {
          await response.body?.cancel();
          assert.ok(!readable, `${name}: ${entry.Path} (${entry.Method})`);
          continue;
        }
        assert.equal(response.status, 200, `${name}: ${entry.Path}`);
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          readFileSync(join(extractedOf(name), entry.Path)),
          `${name}: ${entry.Path}`,
        );
      }
    }
  });
});
