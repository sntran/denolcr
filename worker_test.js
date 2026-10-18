/**
 * The tests of `_worker.js`: rfetch as a service, with no configuration in
 * the Worker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "./_worker.js";

const PASSWORD = "4OSlj-ZYMGdEIGjcWg_gc-DL4O3TFAvr4ct_yV4";

/** The static files of the site: a stub that tells the path. */
const env = {
  ASSETS: {
    /** @param {Request} request */
    fetch: (request) =>
      new Response(`asset ${new URL(request.url).pathname}`, { status: 200 }),
  },
};

/**
 * Sends a request to the Worker.
 * @param {string} path The path and the query, with percent-encoding.
 * @param {RequestInit} [init]
 */
function send(path, init = {}) {
  return worker.fetch(
    new Request(`https://rfetch.test${path}`, { duplex: "half", ...init }),
    env,
  );
}

test("puts and gets a file of a remote on the fly", async () => {
  const put = await send("/:memory:/worker/a%3F.txt", {
    method: "PUT",
    body: "text",
  });
  assert.equal(put.status, 201);
  assert.equal(await (await send("/:memory:/worker/a%3F.txt")).text(), "text");
  assert.equal((await send("/:memory:/worker/missing.txt")).status, 404);
});

test("reads a named remote of the headers", async () => {
  const headers = { RFETCH_CONFIG_MEM_TYPE: "memory" };
  await send("/mem:worker/b.txt", { method: "PUT", body: "b", headers });
  const response = await send("/mem:worker/b.txt", { headers });
  assert.equal(await response.text(), "b");
  // With no headers, the remote does not exist.
  assert.equal((await send("/mem:worker/b.txt")).status, 404);
});

test("the fields of the query are options of the remote", async () => {
  await send("/:memory:/it's/c.txt", { method: "PUT", body: "c" });
  const list = await send(
    `/:alias:/?remote=${encodeURIComponent(":memory:/it's")}`,
  );
  assert.equal(list.status, 200);
  const html = await list.text();
  // A link of the list works as it is.
  const href = html.match(/href="(c\.txt[^"]*)"/)?.[1]?.replaceAll(
    "&amp;",
    "&",
  );
  assert.ok(href, html);
  const file = await send(`/:alias:/${href}`);
  assert.equal(await file.text(), "c");
});

test("gives the list of lsjson for Accept: application/json", async () => {
  await send("/:memory:/json/a.txt", { method: "PUT", body: "a" });
  await send("/:memory:/json/sub/b.txt", { method: "PUT", body: "bb" });
  const headers = { Accept: "application/json" };

  const one = await send("/:memory:/json/", { headers });
  assert.equal(one.headers.get("Content-Type"), "application/json");
  assert.deepEqual(
    (await one.json()).map(({ Path, IsDir }) => ({ Path, IsDir })),
    [{ Path: "a.txt", IsDir: false }, { Path: "sub", IsDir: true }],
  );

  const all = await send("/:memory:/json/", {
    headers: { ...headers, Depth: "infinity" },
  });
  assert.deepEqual(
    (await all.json()).map(({ Path, Size }) => ({ Path, Size })).sort((a, b) =>
      a.Path < b.Path ? -1 : 1
    ),
    [
      { Path: "a.txt", Size: 1 },
      { Path: "sub", Size: -1 },
      { Path: "sub/b.txt", Size: 2 },
    ],
  );

  const two = await send("/:memory:/json/", {
    headers: { ...headers, Depth: "1" },
  });
  assert.equal((await two.json()).length, 2);

  for (const depth of ["0", "-1", "a", "99999"]) {
    const bad = await send("/:memory:/json/", {
      headers: { ...headers, Depth: depth },
    });
    assert.equal(bad.status, 400, depth);
  }
});

test("lists crypt on a named remote, all from the headers", async () => {
  const headers = {
    RFETCH_CRYPT_REMOTE: "vault:crypt-worker",
    RFETCH_CRYPT_PASSWORD: PASSWORD,
    RFETCH_CONFIG_VAULT_TYPE: "memory",
  };
  const put = await send("/:crypt:/x%20y.txt", {
    method: "PUT",
    body: "secret",
    headers,
  });
  assert.equal(put.status, 201);
  const list = await send("/:crypt:/", {
    headers: { ...headers, Accept: "application/json" },
  });
  const entries = await list.json();
  assert.deepEqual(entries.map(({ Name, Size }) => ({ Name, Size })), [
    { Name: "x y.txt", Size: 6 },
  ]);
  const html = await (await send("/:crypt:/", { headers })).text();
  assert.doesNotMatch(html, new RegExp(PASSWORD));
  assert.doesNotMatch(html, /href="[^"]*\?/, "a link has options");
});

test("gives a path with no remote to the static files", async () => {
  assert.equal(await (await send("/")).text(), "asset /");
  assert.equal(await (await send("/README.md")).text(), "asset /README.md");
});

test("gives 400 or 404 for a remote that is not correct", async () => {
  assert.equal((await send("/:no-such-type:/a")).status, 404);
  assert.equal((await send("/nobody:a")).status, 404);
  assert.equal((await send("/:memory:/a?bad%20key=1")).status, 400);
  assert.equal((await send("/:memory%:/a")).status, 400);
});

test("has no local backend: a client reads no file of the runtime", async () => {
  for (
    const [path, headers] of [
      ["/:local:/etc/hostname", {}],
      ["/:alias:hostname", { RFETCH_ALIAS_REMOTE: "/etc/" }],
      ["/:combine:x/hostname", { RFETCH_COMBINE_UPSTREAMS: "x=/etc" }],
      ["/disk:etc/hostname", { RFETCH_CONFIG_DISK_TYPE: "local" }],
    ]
  ) {
    const response = await send(path, { headers });
    assert.equal(response.status, 404, path);
    assert.match(await response.text(), /Backend local not found/);
  }
});
