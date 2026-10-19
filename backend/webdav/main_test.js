/**
 * The tests of the webdav backend: the shared tests on
 * `rclone serve webdav`, when rclone is in the PATH or when RCLONE is the
 * path of rclone, and the tests of the quirks of other servers on a small
 * server of the tests.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { obscure } from "@rfetch/lib/obscure";
import { backendSuite } from "@rfetch/lib/testing/suite";
import { remote } from "@rfetch/lib/testing/remote";
import { listen } from "@rfetch/lib/testing/server";
import webdav, { parseTime } from "./main.js";
import { LOGIN, serveWebDAV } from "./testing.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

/** The password of the test server, obscured as in the config of rclone. */
const pass = await (await obscure(LOGIN.pass)).text();

if (hasRclone) {
  const server = await serveWebDAV();
  after(() => server.stop());

  backendSuite("webdav", webdav, {
    type: "webdav",
    params: { url: server.url, vendor: "rclone", user: LOGIN.user, pass },
    // `rclone serve webdav` gives the time of a COPY to the source file.
    features: {
      copy: true,
      move: true,
      dirMove: true,
      modTime: true,
      copyModTime: false,
    },
  });
  // The vendor `other` sends the standard properties in each PROPFIND, and
  // a body of unknown size in one piece.
  backendSuite("webdav other", webdav, {
    params: { url: server.url, user: LOGIN.user, pass },
    features: { copy: true, move: true, dirMove: true },
  });

  describe("webdav on rclone serve webdav", () => {
    const params = { url: server.url, user: LOGIN.user, pass };
    const fs = remote(webdav, { params, root: "/webdav-test/" });

    test("puts no secret in the links of a list", async () => {
      await fs.put("a b.txt", new TextEncoder().encode("a"));
      const html = await fs.get("").then((response) => response.text());
      assert.ok(html.includes(' href="a%20b.txt?url='));
      assert.ok(!html.includes("user="), "the user is in a link");
      assert.ok(!html.includes("pass="), "the password is in a link");
      await fs.delete("");
    });

    test("puts a body of unknown size", async () => {
      for (const vendor of ["rclone", "other"]) {
        const client = remote(webdav, {
          params: { ...params, vendor },
          root: "/webdav-test/",
        });
        const bytes = new Uint8Array(100_000).map((_, i) => i * 7);
        const body = new Blob([bytes]).stream();
        const response = await client.send("stream.bin", {
          method: "PUT",
          body,
        });
        assert.equal(response.status, 201, vendor);
        const got = await client.get("stream.bin");
        assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
      }
      await fs.delete("");
    });

    test("gives 401 with a bad password", async () => {
      const bad = remote(webdav, {
        params: { ...params, pass: await (await obscure("bad")).text() },
      });
      const response = await bad.get("");
      await response.body?.cancel();
      assert.equal(response.status, 401);
    });

    test("gives 404 for a file as a folder, and a folder as a file", async () => {
      await fs.put("dir/file.txt", new TextEncoder().encode("a"));
      for (const path of ["dir/file.txt/", "dir"]) {
        const response = await fs.get(path);
        await response.body?.cancel();
        assert.equal(response.status, 404, path);
      }
      await fs.delete("");
    });
  });
} else {
  test("webdav and rclone serve webdav", {
    skip: "rclone is not installed. Set RCLONE to its path.",
  }, () => {});
}

/**
 * A small WebDAV server for the tests: it gives the answers of a function,
 * and keeps the requests.
 * @param {(request: Request) => Response | Promise<Response>} handler
 */
async function fakeServer(handler) {
  /** @type {Request[]} */
  const requests = [];
  const server = await listen(async (request) => {
    requests.push(request.clone());
    return await handler(request);
  });
  return { url: server.url, requests, close: server.close };
}

/**
 * A multistatus of WebDAV.
 * @param {string} responses
 */
function multistatus(responses) {
  return new Response(
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" ` +
      `xmlns:oc="http://owncloud.org/ns">${responses}</d:multistatus>`,
    { status: 207, headers: { "Content-Type": "application/xml" } },
  );
}

describe("webdav quirks", () => {
  /** @type {Awaited<ReturnType<typeof fakeServer>>} */
  let server;
  /** @type {(request: Request) => Response | Promise<Response>} */
  let handler;
  before(async () => {
    server = await fakeServer((request) => handler(request));
  });
  after(() => server.close());

  test("reads a list of Nextcloud, with its quirks", async () => {
    handler = () =>
      multistatus(`
<d:response><d:href>/remote.php/dav/files/u/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>
  <d:getlastmodified>Fri, 05 Jan 2018 14:14:38 +0100</d:getlastmodified>
  <oc:permissions>RGDNVCK</oc:permissions></d:prop>
  <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><d:getcontentlength/><oc:checksums/></d:prop>
  <d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/files/u/a%20b.txt</d:href>
  <d:propstat><d:prop><d:resourcetype/>
  <d:getcontentlength>12</d:getcontentlength>
  <d:getlastmodified>Wed, 27 Sep 2017 14:28:34 GMT</d:getlastmodified>
  <oc:checksums><oc:checksum>SHA1:abc</oc:checksum></oc:checksums>
  <oc:permissions>RGDNVW</oc:permissions></d:prop>
  <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><d:getcontentlength/></d:prop>
  <d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
<d:response><d:href>http://other.host/remote.php/dav/files/u/Shared/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>
  <d:getlastmodified>Fri, 7 Sep 2018 08:49:58 GMT</d:getlastmodified>
  <oc:permissions>SRGDNVCK</oc:permissions></d:prop>
  <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/files/u/bad.txt</d:href>
  <d:propstat><d:prop><d:getcontentlength>1</d:getcontentlength></d:prop>
  <d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response>
<d:response><d:href>/elsewhere/x.txt</d:href></d:response>`);
    const params = {
      url: new URL("remote.php/dav/files/u", server.url).href,
      vendor: "nextcloud",
    };
    const fs = remote(webdav, { params });
    server.requests.length = 0;
    assert.deepEqual(await fs.list(""), [
      {
        Name: "a b.txt",
        IsDir: false,
        Size: 12,
        MimeType: "text/plain; charset=utf-8",
        ModTime: "2017-09-27T14:28:34Z",
      },
      {
        Name: "Shared",
        IsDir: true,
        Size: -1,
        MimeType: "",
        ModTime: "2018-09-07T08:49:58Z",
      },
    ]);
    const [request] = server.requests;
    assert.equal(request.method, "PROPFIND");
    assert.equal(request.headers.get("Depth"), "1");
    assert.match(await request.text(), /<oc:checksums \/>/);

    const shares = remote(webdav, {
      params: { ...params, owncloud_exclude_shares: "true" },
    });
    assert.deepEqual((await shares.list("")).map(({ Name }) => Name), [
      "a b.txt",
    ]);
  });

  test("gives the folder of a PROPFIND that is a file as 404", async () => {
    handler = () =>
      multistatus(`<d:response><d:href>/file.txt</d:href><d:propstat>
        <d:prop><d:resourcetype/></d:prop>
        <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
    const fs = remote(webdav, { params: { url: server.url.href } });
    for (const method of ["GET", "HEAD"]) {
      const response = await fs.send("file.txt/", { method });
      await response.body?.cancel();
      assert.equal(response.status, 404, method);
    }
  });

  test("gives 502 when the server is not a WebDAV server", async () => {
    handler = () => new Response("<html></html>", { status: 200 });
    const fs = remote(webdav, { params: { url: server.url.href } });
    const response = await fs.get("");
    await response.body?.cancel();
    assert.equal(response.status, 502);
  });

  test("gives the message of an error of the server", async () => {
    handler = () =>
      new Response(
        `<?xml version="1.0"?><d:error xmlns:d="DAV:" ` +
          `xmlns:s="http://sabredav.org/ns"><s:exception>` +
          `Sabre\\DAV\\Exception\\InsufficientStorage</s:exception>` +
          `<s:message>No space</s:message></d:error>`,
        { status: 507 },
      );
    const fs = remote(webdav, { params: { url: server.url.href } });
    const response = await fs.put("a.txt", new Uint8Array(1));
    assert.equal(response.status, 507);
    assert.equal(
      await response.text(),
      "No space: Sabre\\DAV\\Exception\\InsufficientStorage",
    );
  });

  test("makes the parent folders with MKCOL, as rclone", async () => {
    const folders = new Set(["/"]);
    handler = (request) => {
      const { pathname } = new URL(request.url);
      if (request.method !== "MKCOL") {
        return new Response(null, { status: 201 });
      }
      const parent = pathname.replace(/[^/]+\/$/, "");
      if (folders.has(pathname)) return new Response(null, { status: 405 });
      if (!folders.has(parent)) return new Response(null, { status: 409 });
      folders.add(pathname);
      return new Response(null, { status: 201 });
    };
    const fs = remote(webdav, { params: { url: server.url.href } });
    server.requests.length = 0;
    const response = await fs.put("a/b/c.txt", new Uint8Array(3));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("Content-Location"), "/a/b/c.txt");
    assert.deepEqual(
      server.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`),
      [
        "MKCOL /a/b/",
        "MKCOL /a/",
        "MKCOL /a/b/",
        "PUT /a/b/c.txt",
      ],
    );
    assert.equal(server.requests[3].headers.get("Content-Length"), "3");
    assert.equal(
      server.requests[3].headers.get("Content-Type"),
      "text/plain; charset=utf-8",
    );

    // A folder that exists is not an error.
    const again = await fs.put("a/", new Uint8Array(0));
    assert.equal(again.status, 201);
  });

  test("sends the user and the password, or the token", async () => {
    handler = () => multistatus("");
    for (
      const [params, expected] of [
        [
          { user: "u", pass },
          `Basic ${btoa(`u:${LOGIN.pass}`.replace("é", "\xc3\xa9"))}`,
        ],
        [{ user: "u" }, `Basic ${btoa("u:")}`],
        [{ bearer_token: "t0k" }, "Bearer t0k"],
        [{ headers: "Authorization,Custom x" }, "Custom x"],
        [{}, null],
      ]
    ) {
      server.requests.length = 0;
      const fs = remote(webdav, {
        params: { url: server.url.href, ...params },
      });
      await fs.list("");
      const [request] = server.requests;
      assert.equal(request.headers.get("Authorization"), expected);
      assert.equal(request.headers.get("Referer"), server.url.href);
    }
  });

  test("follows a redirect with the method, and keeps the secrets", async () => {
    /** @type {Awaited<ReturnType<typeof fakeServer>>} */
    const other = await fakeServer(() => multistatus(""));
    try {
      handler = (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/old/") {
          return new Response(null, {
            status: 301,
            headers: { Location: "/new/" },
          });
        }
        if (pathname === "/away/") {
          return new Response(null, {
            status: 307,
            headers: { Location: new URL("/x/", other.url).href },
          });
        }
        return multistatus("");
      };
      const params = { url: server.url.href, user: "u", headers: "X-Key,1" };
      const fs = remote(webdav, { params });
      server.requests.length = 0;
      assert.deepEqual(await fs.list("old/"), []);
      assert.deepEqual(
        server.requests.map((r) => [r.method, new URL(r.url).pathname]),
        [["PROPFIND", "/old/"], ["PROPFIND", "/new/"]],
      );
      assert.ok(server.requests[1].headers.get("Authorization"));

      // Another host gets no secret, unless auth_redirect.
      for (const authRedirect of ["false", "true"]) {
        other.requests.length = 0;
        const client = remote(webdav, {
          params: { ...params, auth_redirect: authRedirect },
        });
        assert.deepEqual(await client.list("away/"), []);
        const [request] = other.requests;
        assert.equal(request.method, "PROPFIND");
        const keep = authRedirect === "true";
        assert.equal(request.headers.has("Authorization"), keep, authRedirect);
        assert.equal(request.headers.has("X-Key"), keep, authRedirect);
      }
    } finally {
      await other.close();
    }
  });

  test("refuses the options that rfetch does not know", async () => {
    for (
      const [params, status] of [
        [{ vendor: "sharepoint" }, 501],
        [{ vendor: "sharepoint-ntlm" }, 501],
        [{ vendor: "nosuch" }, 501],
        [{ bearer_token_command: "echo x" }, 501],
        [{ unix_socket: "/tmp/s" }, 501],
        [{ encoding: "Slash" }, 501],
        [{ headers: "Odd" }, 400],
        [{ pass: "not obscured" }, 400],
      ]
    ) {
      const fs = remote(webdav, {
        params: { url: server.url.href, ...params },
      });
      const response = await fs.get("");
      await response.body?.cancel();
      assert.equal(response.status, status, JSON.stringify(params));
    }
    for (const url of ["", "ftp://host/", "http://u:p@host/"]) {
      const fs = remote(webdav, { params: { url } });
      const response = await fs.get("");
      await response.body?.cancel();
      assert.equal(response.status, 400, url);
    }
  });
});

test("parseTime reads the times that rclone reads", () => {
  for (
    const [text, expected] of [
      ["Wed, 27 Sep 2017 14:28:34 GMT", "2017-09-27T14:28:34Z"],
      ["Fri, 05 Jan 2018 14:14:38 +0000", "2018-01-05T14:14:38Z"],
      ["Fri, 05 Jan 2018 14:14:38 +0130", "2018-01-05T12:44:38Z"],
      ["Fri, 05 Jan 2018 14:14:38 -0700", "2018-01-05T21:14:38Z"],
      ["Wed May 17 15:31:58 UTC 2017", "2017-05-17T15:31:58Z"],
      ["Wed May  7 15:31:58 UTC 2017", "2017-05-07T15:31:58Z"],
      ["Fri, 7 Sep 2018 08:49:58 GMT", "2018-09-07T08:49:58Z"],
      // A zone name that Go does not know is UTC.
      ["Wed, 31 Oct 2018 13:57:11 CET", "2018-10-31T13:57:11Z"],
      ["2018-10-31T13:57:11+01:00", "2018-10-31T12:57:11Z"],
      ["2018-10-31T13:57:11.5Z", "2018-10-31T13:57:11.500Z"],
      // An empty time, and a time that rclone cannot read, are the time 0.
      ["", "1970-01-01T00:00:00Z"],
      ["yesterday", "1970-01-01T00:00:00Z"],
      ["Wed, 31 Feb 2018 13:57:11 GMT", "1970-01-01T00:00:00Z"],
      ["Wed, 27 Sep 2017 24:28:34 GMT", "1970-01-01T00:00:00Z"],
    ]
  ) {
    assert.equal(parseTime(text), expected, text);
  }
});
