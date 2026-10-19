/**
 * The tests of combine against rclone, on the same local folders. The
 * tests run when rclone is in the PATH, or when RCLONE is the path of rclone.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
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

/** The files of each upstream folder, with their content. */
const FILES = {
  "one/a.txt": "a",
  "one/sub/b.txt": "bb",
  "one/sub/deeper/c.txt": "ccc",
  "two words/d e.txt": "dddd",
  [`two words/hello? sausage/êé/Hello, 世界/ " ' @ < > & ? + ≠/z.txt`]: "z",
};

describe("combine and rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-combine-"));
  const upstreams = `one=${folder}/one "two words=${folder}/two words"`;
  const remote = `:combine,upstreams='${upstreams}':`;
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
  }
  after(() => rmSync(folder, { recursive: true, force: true }));

  /** @param {string[]} args */
  function rclone(...args) {
    return spawnSync(RCLONE, ["--config", join(folder, "none.conf"), ...args], {
      env: { PATH: process.env.PATH, HOME: folder },
      encoding: "utf8",
    });
  }

  /**
   * The items of a list, with no time for the folders of the root: rclone
   * and rfetch give them the time of now.
   * @param {Array<Record<string, unknown>>} items
   */
  function comparable(items) {
    return items.map(({ Path, Name, Size, MimeType, ModTime, IsDir }) => ({
      Path,
      Name,
      // rfetch gives -1 for the size of a local folder.
      Size: IsDir ? -1 : Size,
      MimeType,
      ModTime: IsDir && !`${Path}`.includes("/") ? "" : ModTime,
      IsDir,
    })).sort((a, b) => a.Path < b.Path ? -1 : a.Path > b.Path ? 1 : 0);
  }

  for (
    const [path, flags] of [["", {}], ["", { recursive: true }], ["one/sub", {
      recursive: true,
    }], ["two words/", {}]]
  ) {
    test(`lsjson ${JSON.stringify(path)} ${JSON.stringify(flags)}`, async () => {
      const args = ["lsjson", `${remote}${path}`];
      if (flags.recursive) args.push("-R");
      const expected = rclone(...args);
      assert.equal(expected.status, 0, expected.stderr);
      const response = await lsjson(`${remote}${path}`, flags);
      assert.equal(response.status, 200);
      assert.deepEqual(
        comparable(await response.json()),
        comparable(JSON.parse(expected.stdout)),
      );
    });
  }

  test("rclone reads a file that rfetch writes through combine", async () => {
    const put = await fetch(`${remote}two words/new/f.txt`, {
      method: "PUT",
      body: "from rfetch",
    });
    assert.equal(put.status, 201);
    assert.equal(
      readFileSync(join(folder, "two words/new/f.txt"), "utf8"),
      "from rfetch",
    );
    const cat = rclone("cat", `${remote}two words/new/f.txt`);
    assert.equal(cat.stdout, "from rfetch");
  });

  test("rfetch reads a file that rclone writes through combine", async () => {
    const rcat = spawnSync(
      RCLONE,
      ["--config", join(folder, "none.conf"), "rcat", `${remote}one/new/g.txt`],
      { input: "from rclone", env: { PATH: process.env.PATH, HOME: folder } },
    );
    assert.equal(rcat.status, 0, `${rcat.stderr}`);
    const response = await fetch(`${remote}one/new/g.txt`);
    assert.equal(await response.text(), "from rclone");
  });

  test("rfetch gives the errors of rclone for the upstreams", async () => {
    for (
      const value of [
        "",
        "one",
        "=x",
        "one=",
        `a/b=${folder}`,
        `a=${folder} a=${folder}`,
      ]
    ) {
      const location = `:combine,upstreams='${value}':`;
      const { stderr } = rclone("lsjson", location);
      const response = await fetch(location);
      assert.equal(response.status, 400, value);
      const message = await response.text();
      assert.ok(
        stderr.includes(`: ${message}\n`),
        `${value}: ${message}\n${stderr}`,
      );
    }
  });
});
