import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import { mimeType } from "@rfetch/lib/mime";
import { backendSuite } from "@rfetch/lib/testing/suite";
import { remote } from "@rfetch/lib/testing/remote";
import { listen } from "@rfetch/lib/testing/server";
import memory from "@rfetch/memory";
import backend from "./main.js";

/** A server of the memory backend, with the headers of each request. */
const requests = [];
const server = await listen((request) => {
  requests.push(request);
  return memory.fetch(request);
});
after(() => server.close());

// The suite writes to the memory backend, and reads through the server.
backendSuite("http", backend, {
  type: "http",
  params: { url: `${server.url}` },
  writer: memory,
});

/** @param {string} text */
const bytes = (text) => new TextEncoder().encode(text);

describe("http", () => {
  const fs = remote(backend, { params: { url: `${server.url}http-test` } });
  const files = remote(memory, { root: "/http-test/" });

  test("gives 400 for an url option that is not an http URL", async () => {
    for (const url of [undefined, "", "a/b", "file:///etc/", "ftp://a/"]) {
      const params = url === undefined ? {} : { url };
      const response = await remote(backend, { params }).get("");
      await response.body?.cancel();
      assert.equal(response.status, 400, `${url}`);
    }
  });

  test("is read only", async () => {
    await files.put("a.txt", bytes("a"));
    for (const method of ["PUT", "DELETE", "POST", "PROPFIND"]) {
      const response = await fs.send("a.txt", { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get("Allow"), "GET, HEAD");
    }
    assert.equal(await (await files.get("a.txt")).text(), "a");
  });

  test("resolves a path relative to the url option", async () => {
    await files.put("a b/c?.txt", bytes("c"));
    for (const url of [`${server.url}http-test`, `${server.url}http-test/`]) {
      const response = await remote(backend, { params: { url } })
        .get("a b/c?.txt");
      assert.equal(await response.text(), "c", url);
    }
  });

  test("sends the headers option to the server", async () => {
    const headers = 'Cookie,"a=1, b=2",X-Key,secret';
    const fs = remote(backend, {
      params: { url: `${server.url}http-test`, headers },
    });
    requests.length = 0;
    await (await fs.get("a.txt")).text();
    const html = await (await fs.get("")).text();

    assert.ok(requests.length >= 2);
    for (const request of requests) {
      assert.equal(request.headers.get("Cookie"), "a=1, b=2");
      assert.equal(request.headers.get("X-Key"), "secret");
    }
    // The links of the list do not have the headers option.
    assert.ok(html.includes(' href="a.txt?url='));
    assert.ok(!html.includes("secret"));
  });

  test("gives 400 for a headers option that is not correct", async () => {
    for (const headers of ["Cookie", "a,b,c", 'X-Key,"a', "Bad Name,a"]) {
      const fs = remote(backend, {
        params: { url: `${server.url}http-test`, headers },
      });
      const response = await fs.get("a.txt");
      await response.body?.cancel();
      assert.equal(response.status, 400, headers);
    }
  });

  test("gives 404 for a file or a folder that is not on the server", async () => {
    for (const path of ["missing.txt", "missing/"]) {
      const response = await fs.get(path);
      await response.body?.cancel();
      assert.equal(response.status, 404, path);
    }
  });

  test("gives 502 when the server does not answer", async () => {
    const closed = await listen(() => new Response());
    await closed.close();
    const response = await remote(backend, { params: { url: `${closed.url}` } })
      .get("a.txt");
    await response.body?.cancel();
    assert.equal(response.status, 502);
  });

  test("gives 502 for a folder that is not an HTML page", async () => {
    const json = await listen(() => Response.json([]));
    try {
      const response = await remote(backend, { params: { url: `${json.url}` } })
        .get("");
      await response.body?.cancel();
      assert.equal(response.status, 502);
    } finally {
      await json.close();
    }
  });

  test("gives the body of an encoded file with no Content-Length", async () => {
    const gzip = await listen(() =>
      new Response(gzipSync("hello"), {
        headers: { "Content-Encoding": "gzip", "Content-Type": "text/plain" },
      })
    );
    try {
      const response = await remote(backend, { params: { url: `${gzip.url}` } })
        .get("a.txt");
      assert.equal(response.headers.get("Content-Length"), null);
      assert.equal(await response.text(), "hello");
    } finally {
      await gzip.close();
    }
  });
});

describe("http with an index page that is not of rfetch", () => {
  /** The files of the server, and an index page as Apache makes it. */
  const FILES = {
    "/files/a.txt": "a",
    "/files/b c.json": "{}",
    "/files/d.bin": "ddd",
    "/files/e&f.txt": "eeee",
  };
  const INDEX = `<!DOCTYPE html>
<html><body><h1>Index of /files</h1><pre>
<a href="?C=N;O=D">Name</a> <a href="?C=S;O=A">Size</a>
<a href="/">Parent Directory</a>
<a href="a.txt">a.txt</a>      17-Oct-2026 10:00    1
<a href="./b%20c.json">b c.json</a> 17-Oct-2026 10:00    2
<a href="http://127.0.0.1:1/files/x.txt">x.txt</a>
<a href="/files/d.bin">d.bin</a>   17-Oct-2026 10:00    3
<a href="d.bin">d.bin again</a>
<a href="e&amp;f.txt">e&amp;f.txt</a>  17-Oct-2026 10:00    4
<script>document.write('<a href="script.txt">')</script>
<!-- <a href="comment.txt">comment.txt</a> -->
<a href="lost.txt">lost.txt</a>
<a href="sub/">sub/</a>
<a href="sub/deep.txt">sub/deep.txt</a>
<a href="#top">top</a>
</pre></body></html>`;
  const LAST_MODIFIED = "Sat, 17 Oct 2026 10:00:00 GMT";

  const requests = [];
  let index;
  let fs;

  test("starts the server", async () => {
    index = await listen((request) => {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      requests.push(`${request.method} ${pathname}`);
      if (pathname === "/files/") {
        return new Response(INDEX, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (pathname in FILES) {
        // Bytes, thus the server sends no Content-Type.
        const body = bytes(FILES[pathname]);
        return new Response(request.method === "HEAD" ? null : body, {
          headers: {
            "Content-Length": `${body.length}`,
            "Last-Modified": LAST_MODIFIED,
          },
        });
      }
      return new Response(null, { status: 404 });
    });
    fs = remote(backend, { params: { url: `${index.url}files/` } });
  });
  after(() => index?.close());

  test("lists each link to a child of the folder one time", async () => {
    const entries = await fs.list("");
    const time = new Date(LAST_MODIFIED).toISOString();
    assert.deepEqual(
      entries.map(({ Name, IsDir, Size, ModTime }) => ({
        Name,
        IsDir,
        Size,
        ModTime,
      })),
      [
        { Name: "a.txt", IsDir: false, Size: 1, ModTime: time },
        { Name: "b c.json", IsDir: false, Size: 2, ModTime: time },
        { Name: "d.bin", IsDir: false, Size: 3, ModTime: time },
        { Name: "e&f.txt", IsDir: false, Size: 4, ModTime: time },
        // A file whose HEAD request fails is not in the list, as in rclone.
        { Name: "sub", IsDir: true, Size: -1, ModTime: "" },
      ],
    );
    assert.equal(entries[1].MimeType, "application/json");
  });

  test("sends no HEAD request with no_head", async () => {
    const fs = remote(backend, {
      params: { url: `${index.url}files/`, no_head: "true" },
    });
    requests.length = 0;
    const entries = await fs.list("");
    assert.deepEqual(requests, ["GET /files/"]);
    assert.deepEqual(
      entries.map(({ Name, Size, MimeType }) => ({ Name, Size, MimeType })),
      [
        { Name: "a.txt", Size: -1, MimeType: mimeType("a.txt") },
        { Name: "b c.json", Size: -1, MimeType: "application/json" },
        { Name: "d.bin", Size: -1, MimeType: "application/octet-stream" },
        { Name: "e&f.txt", Size: -1, MimeType: mimeType("e&f.txt") },
        { Name: "lost.txt", Size: -1, MimeType: mimeType("lost.txt") },
        { Name: "sub", Size: -1, MimeType: "" },
      ],
    );
  });

  test("gets a file with the headers of the server", async () => {
    const response = await fs.get("b c.json");
    assert.equal(response.headers.get("Content-Length"), "2");
    assert.equal(response.headers.get("Last-Modified"), LAST_MODIFIED);
    assert.equal(response.headers.get("Content-Type"), "application/json");
    assert.equal(await response.text(), "{}");
  });
});

describe("http redirects with the headers option", () => {
  test("do not send the headers to a different host", async () => {
    /** The Cookie of each request, by the port of its server. */
    const cookies = [];
    const other = await listen((request) => {
      cookies.push(["other", request.headers.get("Cookie")]);
      // Back to the first server.
      return Response.redirect(`${first.url}end.txt`, 302);
    });
    const first = await listen((request) => {
      const { pathname } = new URL(request.url);
      cookies.push([pathname, request.headers.get("Cookie")]);
      if (pathname === "/same.txt") {
        return Response.redirect(`${first.url}end.txt`, 301);
      }
      if (pathname === "/away.txt") {
        return Response.redirect(`${other.url}x.txt`, 307);
      }
      return new Response("end");
    });
    try {
      const fs = remote(backend, {
        params: { url: `${first.url}`, headers: "Cookie,secret" },
      });
      assert.equal(await (await fs.get("same.txt")).text(), "end");
      assert.deepEqual(cookies, [
        ["/same.txt", "secret"],
        ["/end.txt", "secret"],
      ]);

      cookies.length = 0;
      assert.equal(await (await fs.get("away.txt")).text(), "end");
      assert.deepEqual(cookies, [
        ["/away.txt", "secret"],
        ["other", null],
        // The other host chose this URL, thus it gets no headers too.
        ["/end.txt", null],
      ]);
    } finally {
      await first.close();
      await other.close();
    }
  });

  test("stop at a redirect from HTTPS to HTTP", async (t) => {
    const urls = [];
    t.mock.method(globalThis, "fetch", (url) => {
      urls.push(`${url}`);
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: "http://example.com/a.txt" },
        }),
      );
    });
    const fs = remote(backend, {
      params: { url: "https://example.com/", headers: "Cookie,secret" },
    });
    const response = await fs.get("a.txt");
    await response.body?.cancel();
    assert.equal(response.status, 502);
    assert.deepEqual(urls, ["https://example.com/a.txt"]);
  });

  test("stop after 10 redirects", async () => {
    let count = 0;
    const loop = await listen((request) => {
      count++;
      return Response.redirect(request.url, 302);
    });
    try {
      const fs = remote(backend, {
        params: { url: `${loop.url}`, headers: "Cookie,secret" },
      });
      const response = await fs.get("a.txt");
      await response.body?.cancel();
      assert.equal(response.status, 502);
      assert.equal(count, 11);
    } finally {
      await loop.close();
    }
  });
});
