/**
 * The tests of the http backend against the http backend of rclone: the two
 * list the same server, and they must give the same files. The tests run
 * when rclone is in the PATH, or when RCLONE is the path of rclone.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { remote } from "@rfetch/lib/testing/remote";
import { listen } from "@rfetch/lib/testing/server";
// Sets the global `fetch` that reads the paths of remotes.
import "../../mod.js";
import chunker from "@rfetch/chunker";
import crypt from "@rfetch/crypt";
import memory from "@rfetch/memory";
import http from "./main.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

/** The files, with hard names. */
const FILES = {
  "empty.txt": 0,
  "a/one.bin": 1,
  "a/b/c.json": 100,
  "file name #1.txt": 2048,
  [`hello? sausage/êé/Hello, 世界/ " ' @ < > & ? + ≠/z.txt`]: 3000,
};

/** An index page as Apache makes it, at /index/. */
const INDEX = `<!DOCTYPE html>
<html><body><h1>Index of /index</h1><pre>
<a href="?C=N;O=D">Name</a> <a href="?C=S;O=A">Size</a>
<a href="/">Parent Directory</a>
<a href="a.txt">a.txt</a>      17-Oct-2026 10:00    1
<a href="./b%20c.json">b c.json</a> 17-Oct-2026 10:00    2
<a href="http://127.0.0.1:1/index/x.txt">x.txt</a>
<a href="/index/a.txt">a.txt again</a>
<A HREF=e&amp;f&#x20;g.txt>e&amp;f g.txt</A> 17-Oct-2026 10:00    3
<a href="caf&eacute;.txt">caf&eacute;.txt</a> 17-Oct-2026 10:00    4
<script>document.write('<a href="script.txt">script.txt</a>')</script>
<!-- <a href="comment.txt">comment.txt</a> -->
<a href="lost.txt">lost.txt</a>
<a href="sub/">sub/</a>
<a href="sub/deep.txt">sub/deep.txt</a>
<a href="#top">top</a>
</pre></body></html>`;

/** The files of the index page. */
const INDEX_FILES = {
  "/index/a.txt": "a",
  "/index/b c.json": "{}",
  "/index/e&f g.txt": "efg",
  "/index/café.txt": "café",
};

/** @param {number} size */
function content(size) {
  return new Uint8Array(size).map((_, index) => (index * 11 + size) & 0xff);
}

describe("http and rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-http-"));
  let server;

  before(async () => {
    server = await listen((request) => {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      if (pathname === "/index/" || pathname === "/index/sub/") {
        const html = pathname === "/index/" ? INDEX : "<html></html>";
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (pathname in INDEX_FILES) {
        const body = new TextEncoder().encode(INDEX_FILES[pathname]);
        return new Response(request.method === "HEAD" ? null : body, {
          headers: {
            "Content-Length": `${body.length}`,
            "Last-Modified": "Sat, 17 Oct 2026 10:00:00 GMT",
          },
        });
      }
      return memory.fetch(request);
    });
    const files = remote(memory, { root: "/rclone/" });
    for (const [path, size] of Object.entries(FILES)) {
      const response = await files.put(path, content(size));
      assert.equal(response.status, 201, path);
    }
  });
  after(async () => {
    await server?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  /**
   * The output of `rclone lsjson -R` for the http backend of rclone.
   * Node does not answer the requests of rclone when spawnSync waits.
   * @param {string} url
   */
  function lsjson(url) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        RCLONE,
        ["lsjson", "-R", "--http-url", url, ":http:"],
        { env: { PATH: process.env.PATH, HOME: folder } },
      );
      let stdout = "", stderr = "";
      child.stdout.on("data", (data) => stdout += data);
      child.stderr.on("data", (data) => stderr += data);
      child.on("error", reject);
      child.on("close", (status) => {
        if (status === 0) resolve(JSON.parse(stdout));
        else reject(new Error(`rclone lsjson ${url}: ${stderr}`));
      });
    });
  }

  /**
   * The entries of all the folders, through the http backend of rfetch.
   * @param {string} url
   */
  async function walk(url) {
    const fs = remote(http, { params: { url } });
    const entries = [];
    const next = async (path) => {
      for (const entry of await fs.list(path)) {
        entries.push({ ...entry, Path: `${path}${entry.Name}` });
        if (entry.IsDir) await next(`${path}${entry.Name}/`);
      }
    };
    await next("");
    return entries;
  }

  /** The fields to compare, in the order of the paths. */
  function normalize(entries) {
    return entries
      .map(({ Path, IsDir, Size, MimeType, ModTime }) => ({
        Path,
        IsDir,
        Size: IsDir ? -1 : Size,
        MimeType: IsDir ? "" : MimeType,
        // rclone has the time of Last-Modified, to the second.
        ModTime: IsDir ? 0 : Math.floor(Date.parse(ModTime) / 1000),
      }))
      .sort((a, b) => a.Path < b.Path ? -1 : +(a.Path > b.Path));
  }

  test("list the lists of rfetch with the same files", async () => {
    const url = `${server.url}rclone/`;
    assert.deepEqual(
      normalize(await walk(url)),
      normalize(await lsjson(url)),
    );
  });

  test("list an index page that is not of rfetch with the same files", async () => {
    const url = `${server.url}index/`;
    const expected = normalize(await lsjson(url));
    assert.deepEqual(expected.map(({ Path }) => Path), [
      "a.txt",
      "b c.json",
      "café.txt",
      "e&f g.txt",
      "sub",
    ]);
    assert.deepEqual(normalize(await walk(url)), expected);
  });
});

describe("rclone reads ranges of rfetch", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-range-"));
  /** The backends under the server, with their options. */
  const BACKENDS = {
    crypt: [crypt, {
      remote: ":memory:/rclone-range-crypt",
      // "test-password", obscured by rclone.
      password: "4OSlj-ZYMGdEIGjcWg_gc-DL4O3TFAvr4ct_yV4",
    }],
    chunker: [chunker, {
      remote: ":memory:/rclone-range-chunker",
      chunk_size: "64k",
    }],
  };
  const data = content(3 * 65536 + 1000);
  let server;

  before(async () => {
    server = await listen((request) => {
      const url = new URL(request.url);
      const [, name] = url.pathname.split("/");
      const [backend, params] = BACKENDS[name];
      url.pathname = url.pathname.slice(name.length + 1);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      return backend.fetch(new Request(url, request));
    });
    for (const [backend, params] of Object.values(BACKENDS)) {
      const response = await remote(backend, { params }).put(
        "data.bin",
        data,
      );
      assert.equal(response.status, 201);
    }
  });
  after(async () => {
    await server?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  /**
   * The output of `rclone cat` for a range of a file of the server.
   * @param {string} url
   * @param {number} offset
   * @param {number} count
   */
  function cat(url, offset, count) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        RCLONE,
        [
          "cat",
          "--http-url",
          url,
          ":http:data.bin",
          "--offset",
          `${offset}`,
          "--count",
          `${count}`,
        ],
        { env: { PATH: process.env.PATH, HOME: folder } },
      );
      const chunks = [];
      let stderr = "";
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.on("data", (chunk) => stderr += chunk);
      child.on("error", reject);
      child.on("close", (status) => {
        if (status === 0) resolve(new Uint8Array(Buffer.concat(chunks)));
        else reject(new Error(`rclone cat ${url}: ${stderr}`));
      });
    });
  }

  for (const name of Object.keys(BACKENDS)) {
    test(`${name}: rclone cat --offset --count gives the bytes`, async () => {
      const url = `${server.url}${name}/`;
      for (
        const [offset, count] of [
          [0, 1],
          [65535, 2],
          [65536, 65536],
          [100000, 70000],
          [data.length - 1, 1],
          [70000, -1],
        ]
      ) {
        const end = count < 0 ? data.length : offset + count;
        assert.deepEqual(
          await cat(url, offset, count),
          data.subarray(offset, end),
          `${name} --offset ${offset} --count ${count}`,
        );
      }
    });
  }
});
