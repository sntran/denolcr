/**
 * The tests of `rfetch serve webdav`: the shared tests of the backends on
 * the webdav backend of rfetch, as a client of the server, and the answers
 * of the server to the methods of WebDAV.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";

import { backendSuite } from "@rfetch/lib/testing/suite";
import webdav from "@rfetch/webdav";
import { fetch as rfetch } from "../../../fetch.js";
import { serve } from "../main.js";

/**
 * Starts `serve webdav` on a free port.
 * @param {string} remote
 * @param {Object} [flags]
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>}
 */
async function start(remote, flags = {}) {
  const response = await serve("webdav", remote, {
    addr: "127.0.0.1:0",
    ...flags,
  });
  const reader = response.body.getReader();
  const { value } = await reader.read();
  const [url] = new TextDecoder().decode(value).match(/http:\/\/\S+/);
  return { url: `${url}/`, stop: () => reader.cancel() };
}

/**
 * Sends a request with any method, as a WebDAV client.
 * @param {string} url
 * @param {string} method
 * @param {Record<string, string>} [headers]
 * @param {string} [body]
 * @returns {Promise<{ status: number, headers: Record<string, string | string[]>, text: string }>}
 */
function dav(url, method, headers = {}, body = "") {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString(),
        }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

/** Puts a file in the memory remote. @param {string} path @param {string} text */
async function put(path, text) {
  const response = await rfetch(`:memory:${path}`, {
    method: "PUT",
    body: text,
    headers: { "Content-Length": `${new TextEncoder().encode(text).length}` },
  });
  assert.equal(response.status, 201);
}

/** The text of a file of the memory remote, or its status. @param {string} path */
async function read(path) {
  const response = await rfetch(`:memory:${path}`);
  return response.ok ? await response.text() : response.status;
}

const folder = await rfetch(":memory:/dav/", { method: "PUT" });
assert.equal(folder.status, 201);
const server = await start(":memory:/dav");
after(() => server.stop());

// The webdav backend of rfetch reads and writes through the server.
backendSuite("serve webdav", webdav, {
  type: "webdav",
  params: { url: server.url, vendor: "rclone" },
  // The vendor rclone sends the time on PUT only.
  features: {
    copy: true,
    move: true,
    dirMove: true,
    modTime: true,
    copyModTime: false,
  },
});
backendSuite("serve webdav, vendor other", webdav, {
  params: { url: server.url },
  features: { copy: true, move: true, dirMove: true },
});
// The vendor owncloud sends the time on PUT, COPY and MOVE, and sets it with
// PROPPATCH.
backendSuite("serve webdav, vendor owncloud", webdav, {
  params: { url: server.url, vendor: "owncloud" },
  features: {
    copy: true,
    move: true,
    dirMove: true,
    modTime: true,
    setModTime: true,
  },
});

describe("serve webdav", () => {
  const { url } = server;

  before(async () => {
    await rfetch(":memory:/dav/t/", { method: "DELETE" });
    await put("/dav/t/a.txt", "a");
    await put("/dav/t/sub/b.txt", "bb");
  });

  test("answers OPTIONS with the classes of WebDAV", async () => {
    const { status, headers } = await dav(url, "OPTIONS");
    assert.equal(status, 200);
    assert.equal(headers.dav, "1, 2");
    assert.match(headers.allow, /PROPFIND/);
    assert.match(headers.allow, /LOCK/);
  });

  test("gives the properties of a file, a folder and its entries", async () => {
    const file = await dav(`${url}t/a.txt`, "PROPFIND", { Depth: "0" });
    assert.equal(file.status, 207);
    assert.match(file.text, /<D:href>\/t\/a\.txt<\/D:href>/);
    assert.match(file.text, /<D:getcontentlength>1<\/D:getcontentlength>/);
    assert.match(file.text, /<D:getcontenttype>text\/plain/);
    assert.match(file.text, /<D:getlastmodified>\w{3}, \d\d \w{3} \d{4}/);

    // A folder with no "/" at the end has the "/" in its href.
    const folder = await dav(`${url}t`, "PROPFIND", { Depth: "1" });
    assert.equal(folder.status, 207);
    const hrefs = [...folder.text.matchAll(/<D:href>([^<]*)<\/D:href>/g)]
      .map(([, href]) => href);
    assert.deepEqual(hrefs, ["/t/", "/t/a.txt", "/t/sub/"]);
    assert.equal(folder.text.match(/<D:collection\/>/g).length, 2);

    const missing = await dav(`${url}t/missing.txt`, "PROPFIND", {
      Depth: "0",
    });
    assert.equal(missing.status, 404);
  });

  test("gives the properties that a client asks for", async () => {
    const { text } = await dav(
      `${url}t/a.txt`,
      "PROPFIND",
      { Depth: "0", "Content-Type": "application/xml" },
      `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:x="urn:x">` +
        `<d:prop><d:getcontentlength/><d:quota-used-bytes/><x:color/>` +
        `</d:prop></d:propfind>`,
    );
    const [found, missing] = text.split("</D:propstat>");
    assert.match(found, /<D:getcontentlength>1</);
    assert.match(found, /200 OK/);
    assert.match(missing, /<D:quota-used-bytes\/>/);
    assert.match(missing, /<R:color xmlns:R="urn:x"\/>/);
    assert.match(missing, /404 Not Found/);

    const names = await dav(
      `${url}t/a.txt`,
      "PROPFIND",
      { Depth: "0" },
      `<d:propfind xmlns:d="DAV:"><d:propname/></d:propfind>`,
    );
    assert.match(names.text, /<D:getcontentlength\/>/);
  });

  test("refuses a PROPFIND of all the levels, and bad XML", async () => {
    for (const headers of [{ Depth: "infinity" }, {}]) {
      const { status, text } = await dav(url, "PROPFIND", headers);
      assert.equal(status, 403);
      assert.match(text, /<D:propfind-finite-depth\/>/);
    }
    const bad = await dav(url, "PROPFIND", { Depth: "0" }, "<a><b></a>");
    assert.equal(bad.status, 400);
  });

  test("makes a folder with MKCOL, as RFC 4918", async () => {
    assert.equal((await dav(`${url}t/new`, "MKCOL")).status, 201);
    const made = await rfetch(":memory:/dav/t/new/", { method: "HEAD" });
    assert.equal(made.status, 200);
    assert.equal((await dav(`${url}t/new/`, "MKCOL")).status, 405);
    assert.equal((await dav(`${url}t/a.txt`, "MKCOL")).status, 405);
    assert.equal((await dav(`${url}t/no/new/`, "MKCOL")).status, 409);
    assert.equal((await dav(`${url}t/body/`, "MKCOL", {}, "x")).status, 415);
  });

  test("puts, gets and deletes a file", async () => {
    assert.equal((await dav(`${url}t/c.txt`, "PUT", {}, "ccc")).status, 201);
    assert.equal(await read("/dav/t/c.txt"), "ccc");
    const got = await dav(`${url}t/c.txt`, "GET", { Range: "bytes=1-" });
    assert.equal(got.status, 206);
    assert.equal(got.text, "cc");
    assert.equal((await dav(`${url}t/c.txt`, "DELETE")).status, 204);
    assert.equal(await read("/dav/t/c.txt"), 404);
    assert.equal((await dav(`${url}t/c.txt`, "DELETE")).status, 404);
  });

  test("deletes a folder with no / at the end", async () => {
    await put("/dav/t/gone/x.txt", "x");
    assert.equal((await dav(`${url}t/gone`, "DELETE")).status, 204);
    assert.equal(await read("/dav/t/gone/x.txt"), 404);
  });

  test("copies and moves files and folders", async () => {
    const copy = await dav(`${url}t/sub`, "COPY", {
      Destination: `${url}t/copy/`,
    });
    assert.equal(copy.status, 201);
    assert.equal(await read("/dav/t/copy/b.txt"), "bb");
    assert.equal(await read("/dav/t/sub/b.txt"), "bb");

    // Overwrite: F keeps the destination.
    const keep = await dav(`${url}t/a.txt`, "COPY", {
      Destination: `${url}t/copy/b.txt`,
      Overwrite: "F",
    });
    assert.equal(keep.status, 412);
    const over = await dav(`${url}t/a.txt`, "COPY", {
      Destination: `${url}t/copy/b.txt`,
    });
    assert.equal(over.status, 204);
    assert.equal(await read("/dav/t/copy/b.txt"), "a");

    const move = await dav(`${url}t/copy/`, "MOVE", {
      Destination: `/t/moved/`,
    });
    assert.equal(move.status, 201);
    assert.equal(await read("/dav/t/moved/b.txt"), "a");
    assert.equal(await read("/dav/t/copy/b.txt"), 404);

    // A copy of only the folder.
    const only = await dav(`${url}t/sub/`, "COPY", {
      Destination: `${url}t/empty/`,
      Depth: "0",
    });
    assert.equal(only.status, 201);
    assert.equal(await read("/dav/t/empty/b.txt"), 404);
  });

  test("refuses a copy that is not possible", async () => {
    for (
      const [path, headers, status] of [
        ["t/a.txt", {}, 400],
        ["t/a.txt", { Destination: "http://other.host/t/x.txt" }, 502],
        ["t/a.txt", { Destination: `${url}t/a.txt` }, 403],
        ["t/sub/", { Destination: `${url}t/sub/in/` }, 409],
        ["t/sub/b.txt", { Destination: `${url}t/` }, 409],
        ["t/a.txt", { Destination: `${url}t/no/x.txt` }, 409],
        ["t/missing.txt", { Destination: `${url}t/x.txt` }, 404],
        ["t/a.txt", { Destination: `${url}..%2Fx.txt` }, 400],
      ]
    ) {
      const response = await dav(`${url}${path}`, "COPY", headers);
      assert.equal(
        response.status,
        status,
        `${path} ${JSON.stringify(headers)}`,
      );
    }
  });

  test("gives a lock token, and makes an empty file for a new path", async () => {
    const info = `<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:">` +
      `<d:lockscope><d:exclusive/></d:lockscope>` +
      `<d:locktype><d:write/></d:locktype>` +
      `<d:owner><d:href>me</d:href></d:owner></d:lockinfo>`;
    const created = await dav(`${url}t/locked.txt`, "LOCK", {}, info);
    assert.equal(created.status, 201);
    assert.match(created.headers["lock-token"], /^<opaquelocktoken:[\w-]+>$/);
    assert.match(created.text, /<D:owner><D:href>me<\/D:href><\/D:owner>/);
    assert.equal(await read("/dav/t/locked.txt"), "");

    const again = await dav(`${url}t/a.txt`, "LOCK", {}, info);
    assert.equal(again.status, 200);
    const token = again.headers["lock-token"];
    const refresh = await dav(`${url}t/a.txt`, "LOCK", { If: `(${token})` });
    assert.equal(refresh.status, 200);
    assert.equal(refresh.headers["lock-token"], token);
    assert.equal(
      (await dav(`${url}t/a.txt`, "UNLOCK", { "Lock-Token": token })).status,
      204,
    );
    assert.equal((await dav(`${url}t/a.txt`, "UNLOCK")).status, 400);
  });

  test("answers PROPPATCH and keeps no property", async () => {
    const { status, text } = await dav(
      `${url}t/a.txt`,
      "PROPPATCH",
      {},
      `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" ` +
        `xmlns:z="urn:schemas-microsoft-com:"><d:set><d:prop>` +
        `<z:Win32LastModifiedTime>x</z:Win32LastModifiedTime>` +
        `</d:prop></d:set></d:propertyupdate>`,
    );
    assert.equal(status, 207);
    assert.match(
      text,
      /<R:Win32LastModifiedTime xmlns:R="urn:schemas-microsoft-com:"\/>/,
    );
    assert.match(text, /200 OK/);
  });

  test("keeps the client in the folder, and gives it no option", async () => {
    assert.equal(
      (await dav(`${url}..%2F..%2Fx`, "PROPFIND", { Depth: "0" })).status,
      400,
    );
    assert.equal((await dav(url, "TRACE")).status, 405);
    // A header of the client does not tell another remote.
    const response = await dav(`${url}t/a.txt`, "GET", {
      RFETCH_CONFIG_X_TYPE: "local",
    });
    assert.equal(response.text, "a");
  });
});

describe("serve webdav with a login, or only to read", () => {
  test("asks for the user and the password", async () => {
    const locked = await start(":memory:/dav", { user: "u", pass: "p é" });
    try {
      const none = await dav(locked.url, "PROPFIND", { Depth: "0" });
      assert.equal(none.status, 401);
      assert.match(none.headers["www-authenticate"], /^Basic /);
      const bad = await dav(locked.url, "PROPFIND", {
        Depth: "0",
        Authorization: `Basic ${btoa("u:bad")}`,
      });
      assert.equal(bad.status, 401);
      const good = await dav(locked.url, "PROPFIND", {
        Depth: "0",
        Authorization: `Basic ${Buffer.from("u:p é").toString("base64")}`,
      });
      assert.equal(good.status, 207);
    } finally {
      await locked.stop();
    }
  });

  test("refuses the methods that write with --read-only", async () => {
    const readOnly = await start(":memory:/dav", { read_only: true });
    try {
      assert.equal(
        (await dav(readOnly.url, "PROPFIND", { Depth: "0" })).status,
        207,
      );
      for (const method of ["PUT", "DELETE", "MKCOL", "COPY", "MOVE", "LOCK"]) {
        const { status, headers } = await dav(`${readOnly.url}x`, method);
        assert.equal(status, 405, method);
        assert.doesNotMatch(headers.allow, /PUT/);
      }
    } finally {
      await readOnly.stop();
    }
  });
});
