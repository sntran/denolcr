/**
 * The tests of `_worker.js`: rfetch as a service, with no configuration in
 * the Worker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { listen } from "@rfetch/lib/testing/server";
import worker from "./_worker.js";
import memory from "./backend/memory/main.js";

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

test("reads a file in a zip file of a remote, with the remote in the path", async () => {
  const { zipFile } = await import("./backend/archive/testing.js");
  const zip = zipFile([
    { name: "docs/a.txt", data: "in the zip" },
    { name: "b.txt", data: "b".repeat(1000), method: 0 },
  ]);
  const put = await send("/:memory:/worker-zip/files.zip", {
    method: "PUT",
    body: zip,
  });
  assert.equal(put.status, 201);
  const file = await send("/:archive::memory:/worker-zip/files.zip/docs/a.txt");
  assert.equal(file.status, 200);
  assert.equal(await file.text(), "in the zip");
  const part = await send("/:archive::memory:/worker-zip/files.zip/b.txt", {
    headers: { Range: "bytes=10-19" },
  });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), "b".repeat(10));
  const list = await send("/:archive::memory:/worker-zip/", {
    headers: { Accept: "application/json" },
  });
  assert.deepEqual(
    (await list.json()).map(({ Path, IsDir }) => [Path, IsDir]),
    [["files.zip", true]],
  );
  const deep = await send("/:archive::memory:/worker-zip/", {
    headers: { Accept: "application/json", Depth: "infinity" },
  });
  assert.deepEqual(
    (await deep.json()).map(({ Path }) => Path).sort(),
    ["files.zip", "files.zip/b.txt", "files.zip/docs", "files.zip/docs/a.txt"],
  );
});

test("reads a tile of a PMTiles file of a remote", async () => {
  const { pmtilesFile } = await import("./backend/tiles/testing.js");
  const put = await send("/:memory:/worker-tiles/map.pmtiles", {
    method: "PUT",
    body: pmtilesFile([
      { z: 0, x: 0, y: 0, data: "world" },
      { z: 1, x: 1, y: 0, data: "north-east" },
    ]),
  });
  assert.equal(put.status, 201);
  const tile = await send(
    "/:tiles::memory:/worker-tiles/map.pmtiles/1/1/0.mvt",
  );
  assert.equal(tile.status, 200);
  assert.equal(await tile.text(), "north-east");
  const list = await send("/:tiles::memory:/worker-tiles/map.pmtiles/", {
    headers: { Accept: "application/json" },
  });
  assert.deepEqual(
    (await list.json()).map(({ Path }) => Path),
    ["0", "1", "metadata.json"],
  );
});

test("reads a tile of a VersaTiles file of a remote", async () => {
  const { versatilesFile } = await import("./backend/tiles/testing.js");
  const put = await send("/:memory:/worker-tiles/map.versatiles", {
    method: "PUT",
    body: versatilesFile([
      { z: 0, x: 0, y: 0, data: "world" },
      { z: 1, x: 1, y: 0, data: "north-east" },
    ]),
  });
  assert.equal(put.status, 201);
  const tile = await send(
    "/:tiles::memory:/worker-tiles/map.versatiles/1/1/0.mvt",
  );
  assert.equal(tile.status, 200);
  assert.equal(await tile.text(), "north-east");
  // The stored bytes in brotli, for a client that decodes them.
  const stored = await send(
    "/:tiles::memory:/worker-tiles/map.versatiles/0/0/0.mvt",
    { headers: { "Accept-Encoding": "gzip, br" } },
  );
  assert.equal(stored.headers.get("Content-Encoding"), "br");
  await stored.body?.cancel();
});

test("reads a remote with a URL in quotes in the path, and its root", async () => {
  const { pmtilesFile } = await import("./backend/tiles/testing.js");
  await send("/:memory:/worker-url/map.pmtiles", {
    method: "PUT",
    body: pmtilesFile([{ z: 0, x: 0, y: 0, data: "world" }]),
  });
  const server = await listen((request) => memory.fetch(request));
  try {
    const base = `/:tiles::http,url='${server.url}worker-url/':`;
    const tile = await send(`${base}map.pmtiles/0/0/0.mvt`);
    assert.equal(tile.status, 200);
    assert.equal(await tile.text(), "world");
    const list = await send(base, { headers: { Accept: "application/json" } });
    assert.deepEqual(
      (await list.json()).map(({ Path, IsDir }) => [Path, IsDir]),
      [["map.pmtiles", true]],
    );
  } finally {
    await server.close();
  }
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

test("a field or a header with an empty value is not an option", async () => {
  await send("/:memory:/empty/d.txt", { method: "PUT", body: "d" });
  const headers = { RFETCH_ALIAS_REMOTE: ":memory:/empty" };
  // The empty field of the query does not take the place of the header.
  const file = await send("/:alias:/d.txt?remote=", { headers });
  assert.equal(file.status, 200);
  assert.equal(await file.text(), "d");
  // An empty header is no option: the alias has no remote.
  const none = await send("/:alias:/d.txt?remote=", {
    headers: { RFETCH_ALIAS_REMOTE: "" },
  });
  assert.equal(none.ok, false);
  await none.body?.cancel();
});

test("a GET and a HEAD with an empty body read the file", async () => {
  await send("/:memory:/get-body/e.txt", { method: "PUT", body: "e" });
  for (const method of ["GET", "HEAD"]) {
    // A request with `Content-Length: 0` has a body stream in workerd, also
    // for a GET. A Request of Node.js cannot have it, so the test gives the
    // method after the body.
    const url = "https://rfetch.test/:memory:/get-body/e.txt";
    const request = new Request(url, {
      method: "POST",
      headers: { "Content-Length": "0" },
      body: "",
    });
    Object.defineProperty(request, "method", { value: method });
    const file = await worker.fetch(request, env);
    assert.equal(file.status, 200, method);
    assert.equal(await file.text(), method === "GET" ? "e" : "", method);
  }
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
      ["/:union:hostname", { RFETCH_UNION_UPSTREAMS: "/etc :memory:/x" }],
      ["/:compress:", { RFETCH_COMPRESS_REMOTE: "/etc" }],
      ["/:archive:/etc/", {}],
      ["/:tiles:/etc/", {}],
      ["/disk:etc/hostname", { RFETCH_CONFIG_DISK_TYPE: "local" }],
    ]
  ) {
    const response = await send(path, { headers });
    assert.equal(response.status, 404, path);
    assert.match(await response.text(), /Backend local not found/);
  }
});

test("is a WebDAV server for the remotes in its paths", async () => {
  const put = await send("/:memory:/worker-dav/a%20b.txt", {
    method: "PUT",
    body: "dav",
  });
  assert.equal(put.status, 201);

  const options = await send("/:memory:/worker-dav/", { method: "OPTIONS" });
  assert.equal(options.headers.get("DAV"), "1, 2");

  const list = await send("/:memory:/worker-dav/", {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  assert.equal(list.status, 207);
  const xml = await list.text();
  assert.match(xml, /<D:href>\/:memory:\/worker-dav\/<\/D:href>/);
  assert.match(xml, /<D:href>\/:memory:\/worker-dav\/a%20b\.txt<\/D:href>/);

  assert.equal(
    (await send("/:memory:/worker-dav/sub", { method: "MKCOL" })).status,
    201,
  );
  // A copy to another remote, and a move in a remote.
  const copy = await send("/:memory:/worker-dav/a%20b.txt", {
    method: "COPY",
    headers: {
      Destination:
        "https://rfetch.test/:alias,remote=':memory:/worker-dav/sub':c.txt",
    },
  });
  assert.equal(copy.status, 201);
  assert.equal(
    await (await send("/:memory:/worker-dav/sub/c.txt")).text(),
    "dav",
  );
  const move = await send("/:memory:/worker-dav/sub", {
    method: "MOVE",
    headers: { Destination: "/:memory:/worker-dav/moved/" },
  });
  assert.equal(move.status, 201);
  assert.equal(
    await (await send("/:memory:/worker-dav/moved/c.txt")).text(),
    "dav",
  );
  assert.equal((await send("/:memory:/worker-dav/sub/c.txt")).status, 404);

  // A destination with no remote, or the root of a remote, is not possible.
  for (const destination of ["/x.txt", "/:memory:/"]) {
    const response = await send("/:memory:/worker-dav/moved/c.txt", {
      method: "COPY",
      headers: { Destination: destination },
    });
    assert.ok(response.status >= 400, destination);
    await response.body?.cancel();
  }

  assert.equal(
    (await send("/:memory:/worker-dav/moved", { method: "DELETE" })).status,
    204,
  );
  assert.equal((await send("/:memory:/worker-dav/moved/c.txt")).status, 404);
});
