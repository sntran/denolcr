import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backendSuite } from "@rfetch/lib/testing/suite";
import { remote } from "@rfetch/lib/testing/remote";
// Sets the global `fetch` that reads the paths of remotes.
import { fetch } from "../../mod.js";
import backend, { parentOf, unionOf } from "./main.js";

const encoder = new TextEncoder();

backendSuite("union", backend, {
  type: "union",
  params: { upstreams: ":memory:/union-a :memory:/union-b" },
});
// A new file goes to all the upstreams.
backendSuite("union", backend, {
  params: {
    upstreams: ":memory:/union-c :memory:/union-d",
    create_policy: "all",
  },
});

/**
 * A union of new folders of memory, with the folders.
 * @param {string} name
 * @param {string[]} tags The tag of each upstream, for example `:ro`.
 * @param {Record<string, string>} [policies]
 */
function unionFor(name, tags, policies = {}) {
  const folders = tags.map((_, index) => `:memory:/union-${name}-${index}`);
  const upstreams = folders.map((folder, index) => `${folder}${tags[index]}`)
    .join(" ");
  return {
    folders,
    fs: remote(backend, { params: { upstreams, ...policies } }),
  };
}

/** @param {string} location */
async function textOf(location) {
  const response = await fetch(location);
  return response.ok ? await response.text() : response.status;
}

test("unionOf reads the upstreams, their tags and the policies", () => {
  const { upstreams, action, create, search } = unionOf(
    new URLSearchParams({
      upstreams: `a:path:ro "b:with space:nc" c::writeback d:ro`,
      search_policy: "NEWEST",
    }),
  );
  assert.deepEqual(upstreams, [
    { remote: "a:path", writable: false, creatable: false, writeback: false },
    {
      remote: "b:with space",
      writable: true,
      creatable: false,
      writeback: false,
    },
    { remote: "c:", writable: true, creatable: true, writeback: true },
    // `d:ro` is the path `ro` in the remote `d`, as in rclone.
    { remote: "d:ro", writable: true, creatable: true, writeback: false },
  ]);
  assert.deepEqual(action, { ep: true, pick: "all" });
  assert.deepEqual(create, { ep: true, pick: "first" });
  assert.deepEqual(search, { ep: true, pick: "newest" });
  // The old option `remotes`: all but the last are read only.
  const old = unionOf(new URLSearchParams({ remotes: "a: b: c:" }));
  assert.deepEqual(old.upstreams.map(({ writable }) => writable), [
    false,
    false,
    true,
  ]);
});

test("parentOf gives the folder of a path", () => {
  for (
    const [path, parent] of [
      ["/a/b.txt", "/a/"],
      ["/a/b/", "/a/"],
      ["/a.txt", "/"],
      ["/a/", "/"],
      ["/", ""],
    ]
  ) {
    assert.equal(parentOf(path), parent, path);
  }
});

test("unionOf gives the errors of rclone", () => {
  for (
    const [options, message] of [
      [
        {},
        "union can't point to an empty upstream - check the value of the upstreams setting",
      ],
      [
        { upstreams: "a:" },
        "union can't point to a single upstream - check the value of the upstreams setting",
      ],
      [
        { upstreams: "a::writeback b::writeback" },
        "can only have 1 :writeback not 2",
      ],
      [
        { upstreams: "a: b:", create_policy: "nosuch" },
        'didn\'t find policy called "nosuch"',
      ],
    ]
  ) {
    assert.throws(
      () => unionOf(new URLSearchParams(options)),
      { message },
      JSON.stringify(options),
    );
  }
});

test("the list of union has the files of each upstream", async () => {
  const { folders, fs } = unionFor("list", ["", ""]);
  await fetch(`${folders[0]}/dir/a.txt`, { method: "PUT", body: "a" });
  await fetch(`${folders[1]}/dir/b.txt`, { method: "PUT", body: "bb" });
  await fetch(`${folders[1]}/dir/a.txt`, { method: "PUT", body: "other" });
  const entries = await fs.list("dir/");
  assert.deepEqual(
    entries.map(({ Name, Size }) => ({ Name, Size })).sort((a, b) =>
      a.Name < b.Name ? -1 : 1
    ),
    // As the search policy ff, a.txt is the file of the first upstream.
    [{ Name: "a.txt", Size: 1 }, { Name: "b.txt", Size: 2 }],
  );
  assert.equal(await fs.get("dir/a.txt").then((r) => r.text()), "a");
  assert.equal(await fs.get("dir/b.txt").then((r) => r.text()), "bb");
  assert.equal((await fs.get("nosuch/")).status, 404);
  assert.equal((await fs.get("dir/nosuch.txt")).status, 404);
});

test("the search policy newest reads the newest file", async () => {
  const { folders, fs } = unionFor("newest", ["", ""], {
    search_policy: "newest",
  });
  await fetch(`${folders[0]}/f.txt`, { method: "PUT", body: "old" });
  // The time of a file is in seconds in `Last-Modified`.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await fetch(`${folders[1]}/f.txt`, { method: "PUT", body: "new" });
  assert.equal(await fs.get("f.txt").then((r) => r.text()), "new");
  const entries = await fs.list("");
  assert.deepEqual(entries.map(({ Size }) => Size), [3]);
});

test("the search policy newest compares the times in one second, as rclone", async () => {
  const root = mkdtempSync(join(tmpdir(), "rfetch-union-newest-"));
  try {
    // Two files in the same second: `Last-Modified` cannot tell the newest.
    for (
      const [name, content, seconds] of [["a", "a", 0.2], ["b", "bb", 0.7]]
    ) {
      mkdirSync(join(root, name, "dir"), { recursive: true });
      writeFileSync(join(root, name, "dir", "f.txt"), content);
      const time = 1_700_000_000 + seconds;
      utimesSync(join(root, name, "dir", "f.txt"), time, time);
    }
    for (const order of [["a", "b"], ["b", "a"]]) {
      const upstreams = order.map((name) => `"${join(root, name)}"`).join(" ");
      const fs = remote(backend, {
        params: { upstreams, search_policy: "newest" },
      });
      const what = `upstreams ${order}`;
      assert.equal(await (await fs.get("dir/f.txt")).text(), "bb", what);
      const [entry] = await fs.list("dir/");
      assert.equal(entry.Size, 2, what);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new file goes to the upstreams that have its folder (epmfs)", async () => {
  const { folders, fs } = unionFor("epmfs", ["", ""]);
  await fetch(`${folders[0]}/`, { method: "PUT" });
  await fetch(`${folders[1]}/only-b/`, { method: "PUT" });
  assert.equal((await fs.put("only-b/x.txt", encoder.encode("x"))).status, 201);
  assert.equal(await textOf(`${folders[1]}/only-b/x.txt`), "x");
  assert.equal(await textOf(`${folders[0]}/only-b/x.txt`), 404);
  // A folder that no upstream has: the first upstream with the deepest
  // folder of the path.
  assert.equal(
    (await fs.put("new/deep/y.txt", encoder.encode("y"))).status,
    201,
  );
  assert.equal(await textOf(`${folders[0]}/new/deep/y.txt`), "y");
  assert.equal(await textOf(`${folders[1]}/new/deep/y.txt`), 404);
});

test("the create policy ff puts a new file in the first upstream", async () => {
  const { folders, fs } = unionFor("ff", ["", ""], { create_policy: "ff" });
  await fetch(`${folders[1]}/only-b/`, { method: "PUT" });
  await fs.put("only-b/z.txt", encoder.encode("z"));
  assert.equal(await textOf(`${folders[0]}/only-b/z.txt`), "z");
  assert.equal(await textOf(`${folders[1]}/only-b/z.txt`), 404);
});

test("the action policy epall changes and deletes the file in each upstream", async () => {
  const { folders, fs } = unionFor("epall", ["", "", ""]);
  await fetch(`${folders[0]}/f.txt`, { method: "PUT", body: "1" });
  await fetch(`${folders[2]}/f.txt`, { method: "PUT", body: "1" });
  await fetch(`${folders[1]}/`, { method: "PUT" });
  await fs.put("f.txt", encoder.encode("2"));
  assert.equal(await textOf(`${folders[0]}/f.txt`), "2");
  assert.equal(await textOf(`${folders[1]}/f.txt`), 404);
  assert.equal(await textOf(`${folders[2]}/f.txt`), "2");
  assert.equal((await fs.delete("f.txt")).status, 204);
  assert.equal(await textOf(`${folders[0]}/f.txt`), 404);
  assert.equal(await textOf(`${folders[2]}/f.txt`), 404);
  assert.equal((await fs.delete("f.txt")).status, 404);
});

test("the action policy epff deletes the file in the first upstream", async () => {
  const { folders, fs } = unionFor("epff", ["", ""], {
    action_policy: "epff",
  });
  await fetch(`${folders[0]}/f.txt`, { method: "PUT", body: "1" });
  await fetch(`${folders[1]}/f.txt`, { method: "PUT", body: "1" });
  await fs.delete("f.txt");
  assert.equal(await textOf(`${folders[0]}/f.txt`), 404);
  assert.equal(await textOf(`${folders[1]}/f.txt`), "1");
});

test("union does not write to an upstream with :ro", async () => {
  const all = unionFor("ro", [":ro", ":ro"]);
  await fetch(`${all.folders[0]}/f.txt`, { method: "PUT", body: "1" });
  assert.equal((await all.fs.put("new.txt", encoder.encode("x"))).status, 403);
  assert.equal((await all.fs.delete("f.txt")).status, 403);
  assert.equal(await textOf(`${all.folders[0]}/f.txt`), "1");

  // As rclone, a change of a file that is only in an upstream with :ro
  // puts the file in the other upstreams.
  const mixed = unionFor("mixed", [":ro", ""]);
  await fetch(`${mixed.folders[0]}/f.txt`, { method: "PUT", body: "1" });
  await fetch(`${mixed.folders[1]}/`, { method: "PUT" });
  assert.equal((await mixed.fs.put("f.txt", encoder.encode("2"))).status, 201);
  assert.equal(await textOf(`${mixed.folders[0]}/f.txt`), "1");
  assert.equal(await textOf(`${mixed.folders[1]}/f.txt`), "2");
});

test("union changes but does not create a file in an upstream with :nc", async () => {
  const { folders, fs } = unionFor("nc", [":nc", ":nc"]);
  await fetch(`${folders[0]}/f.txt`, { method: "PUT", body: "1" });
  assert.equal((await fs.put("new.txt", encoder.encode("x"))).status, 403);
  assert.equal((await fs.put("f.txt", encoder.encode("2"))).status, 201);
  assert.equal(await textOf(`${folders[0]}/f.txt`), "2");
  assert.equal((await fs.delete("f.txt")).status, 204);
});

test("a read copies a file into the upstream with :writeback", async () => {
  const { folders, fs } = unionFor("writeback", [":writeback", ""]);
  await fetch(`${folders[1]}/f.txt`, { method: "PUT", body: "abcdef" });
  assert.equal(await textOf(`${folders[0]}/f.txt`), 404);
  const range = await fs.get("f.txt", { Range: "bytes=2-3" });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "cd");
  assert.equal(await textOf(`${folders[0]}/f.txt`), "abcdef");
});

test("DELETE of a folder of union deletes it in each upstream", async () => {
  const { folders, fs } = unionFor("purge", ["", ""]);
  await fetch(`${folders[0]}/dir/a.txt`, { method: "PUT", body: "a" });
  await fetch(`${folders[1]}/dir/b.txt`, { method: "PUT", body: "b" });
  assert.equal((await fs.delete("dir/")).status, 204);
  assert.equal(await textOf(`${folders[0]}/dir/a.txt`), 404);
  assert.equal(await textOf(`${folders[1]}/dir/b.txt`), 404);
  assert.equal((await fs.delete("dir/")).status, 404);
});

test("union gives 400 for options that are not correct", async () => {
  const fs = remote(backend, { params: { upstreams: ":memory:/one" } });
  const response = await fs.get("");
  assert.equal(response.status, 400);
  assert.match(await response.text(), /single upstream/);
});
