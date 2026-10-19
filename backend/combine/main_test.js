import { test } from "node:test";
import assert from "node:assert/strict";

import { backendSuite } from "@rfetch/lib/testing/suite";
import { remote } from "@rfetch/lib/testing/remote";
// Sets the global `fetch` that reads the paths of remotes.
import { fetch } from "../../mod.js";
import backend, { upstreamsOf } from "./main.js";

const UPSTREAMS = `a=:memory:/combine-a "b c=:memory:/combine-b"`;

// The tests run in the two upstreams.
backendSuite("combine", backend, {
  type: "combine",
  params: { upstreams: UPSTREAMS },
  parent: "/a/",
});
backendSuite("combine", backend, {
  type: "combine",
  params: { upstreams: UPSTREAMS },
  parent: "/b c/",
});

test("upstreamsOf reads the upstreams as rclone", () => {
  assert.deepEqual(
    [
      ...upstreamsOf(
        `a=s3:bucket "b c=drive:My Drive" "d=:alias,remote='x y':"`,
      ),
    ],
    [["a", "s3:bucket"], ["b c", "drive:My Drive"], [
      "d",
      ":alias,remote='x y':",
    ]],
  );
  // The remote of an upstream can have a "=".
  assert.deepEqual([...upstreamsOf("a=:s3,region=auto:")], [[
    "a",
    ":s3,region=auto:",
  ]]);
});

test("upstreamsOf gives the errors of rclone", () => {
  for (
    const [text, message] of [
      [
        "",
        "combine can't point to an empty upstream - check the value of the upstreams setting",
      ],
      ["a", 'no "=" in upstream definition "a"'],
      ["=x", 'empty dir in upstream definition "=x"'],
      ["a=", 'empty remote in upstream definition "a="'],
      ["a/b=x", 'dirs can\'t contain / (yet): "a/b"'],
      ["a=x a=y", 'duplicate directory name "a"'],
    ]
  ) {
    assert.throws(() => upstreamsOf(text), { message }, text);
  }
});

test("the root of combine has a folder for each upstream", async () => {
  const fs = remote(backend, { params: { upstreams: UPSTREAMS } });
  const entries = await fs.list("");
  assert.deepEqual(entries.map(({ Name, IsDir }) => ({ Name, IsDir })), [
    { Name: "a", IsDir: true },
    { Name: "b c", IsDir: true },
  ]);
  // The root always exists.
  assert.equal((await fs.put("")).status, 201);
  assert.equal((await fs.head("")).status, 200);
});

test("a file of combine goes to the remote of its upstream", async () => {
  const fs = remote(backend, { params: { upstreams: UPSTREAMS } });
  const put = await fs.put("b c/files/one.txt", new TextEncoder().encode("1"));
  assert.equal(put.status, 201);
  assert.equal(put.headers.get("Content-Location"), "/b%20c/files/one.txt");
  const response = await fetch(":memory:/combine-b/files/one.txt");
  assert.equal(await response.text(), "1");
  assert.equal(await fs.get("b c/files/one.txt").then((r) => r.text()), "1");
  // The other upstream does not have it.
  assert.equal((await fs.head("a/files/one.txt")).status, 404);
});

test("a path of combine that is not in an upstream is not found", async () => {
  const fs = remote(backend, { params: { upstreams: UPSTREAMS } });
  for (const path of ["nosuch/", "nosuch/a.txt", "a", "top.txt"]) {
    assert.equal((await fs.get(path)).status, 404, path);
  }
  // As rclone, a file cannot be in the root.
  const put = await fs.put("top.txt", new TextEncoder().encode("x"));
  assert.equal(put.status, 404);
});

test("combine gives 400 for upstreams that are not correct", async () => {
  const fs = remote(backend, { params: { upstreams: "a" } });
  const response = await fs.get("");
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'no "=" in upstream definition "a"');
});

test("the links of a list of combine have the query of combine", async () => {
  const fs = remote(backend, { params: { upstreams: UPSTREAMS } });
  await fs.put("a/links/x y.txt", new TextEncoder().encode("x"));
  const query = new URLSearchParams({ upstreams: UPSTREAMS });
  for (const [path, href] of [["", "a/"], ["a/links/", "x%20y.txt"]]) {
    const html = await fs.get(path).then((response) => response.text());
    assert.ok(
      html.includes(
        ` href="${href}?${query.toString().replaceAll("&", "&amp;")}"`,
      ),
      `${path}: ${href}`,
    );
  }
});

test("DELETE of the root of combine deletes the root of each upstream", async () => {
  const upstreams = "x=:memory:/combine-x y=:memory:/combine-y";
  const fs = remote(backend, { params: { upstreams } });
  await fs.put("x/1.txt", new TextEncoder().encode("1"));
  await fs.put("y/2.txt", new TextEncoder().encode("2"));
  assert.equal((await fs.delete("")).status, 204);
  assert.equal((await fetch(":memory:/combine-x/1.txt")).status, 404);
  assert.equal((await fetch(":memory:/combine-y/2.txt")).status, 404);
  // The root always exists.
  assert.equal((await fs.get("")).status, 200);
});
