import { before, test } from "node:test";
import assert from "node:assert/strict";

import { fetch } from "../../fetch.js";
import { putFiles } from "../testing.js";
import { tree } from "./main.js";

const ROOT = ":memory:/tree/";

before(async () => {
  await putFiles(ROOT, {
    "f.txt": "hello",
    "a/g.txt": "world!",
    "a/b/zero": "",
    ".hidden/x": "x",
    "B.txt": "b",
    "é.txt": "e",
  });
  await (await fetch(`${ROOT}empty/inner/`, { method: "PUT" })).body?.cancel();
});

/** @param {Object} [flags] */
async function text(flags) {
  return await (await tree(ROOT, flags)).text();
}

test("tree draws the folders and the files, as rclone", async () => {
  assert.equal(
    await text(),
    `/
├── B.txt
├── a
│   ├── b
│   │   └── zero
│   └── g.txt
├── empty
│   └── inner
├── f.txt
└── é.txt

4 directories, 5 files
`,
  );
});

test("tree takes the flags of rclone", async () => {
  assert.equal(
    await text({ dirs_only: true, noreport: true }),
    "/\n├── a\n│   └── b\n└── empty\n    └── inner\n",
  );
  assert.equal(
    await text({ level: "1", dirsfirst: true }),
    `/
├── a
├── empty
├── B.txt
├── f.txt
└── é.txt

2 directories, 3 files
`,
  );
  assert.match(await text({ all: true }), /├── \.hidden\n│   └── x\n/);
  assert.match(await text({ size: true }), /\[ {10}6\] {2}g\.txt\n/);
  assert.match(await text({ full_path: true }), /└── \/a\/g\.txt\n/);
  assert.match(await text({ sort_reverse: true }), /^\/\n├── é\.txt\n/);
});

test("tree of a file, and of a path that does not exist", async () => {
  assert.equal(
    await (await tree(`${ROOT}a/g.txt`)).text(),
    "/\n└── g.txt\n\n0 directories, 1 files\n",
  );
  assert.equal((await tree(`${ROOT}missing`)).status, 404);
});
