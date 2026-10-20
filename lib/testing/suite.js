/**
 * The tests that each backend must pass, as `fstests` of rclone
 * (fstest/fstests/fstests.go). A test file of a backend calls
 * `backendSuite(name, backend)` once. The tests run in order, and each test
 * uses the files of the tests before it.
 *
 * The tests use a new folder `/rfetch-test-RANDOM/` and remove it at the end.
 * They do not touch other files of the backend.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { mimeType } from "../mime.js";
import { remote } from "./remote.js";

/**
 * The names of `FsEncoding` of rclone that can be one name in the path of a
 * URL. The names `.` and `..`, the names with a `/`, the name with all the
 * control characters and the name with bad UTF-8 are not here: a URL or a
 * string of JavaScript cannot have them as one name.
 */
const NAMES = [
  " leading space",
  "~leading tilde",
  "\rleading CR",
  "\nleading LF",
  "\tleading HT",
  "\vleading VT",
  ".leading dot",
  "trailing space ",
  "trailing CR\r",
  "trailing LF\n",
  "trailing HT\t",
  "trailing VT\v",
  "trailing dot.",
  "test%46.txt",
  "!\"#$%&'()*+,-.:;<=>?@[\\]^_`{|}~",
  "êé",
  "Hello, 世界",
];

/** The two files of `fstests`: one at the root, and one in folders with hard names. */
const FILE1 = "file name.txt";
const FILE2 = `hello? sausage/êé/Hello, 世界/ " ' @ < > & ? + ≠/z.txt`;

/**
 * What a backend can do other than GET, HEAD, PUT and DELETE, as the
 * features of a backend in rclone.
 * @typedef {Object} Features
 * @property {boolean} [copy] `COPY` of a file, as `Copy` of rclone.
 * @property {boolean} [move] `MOVE` of a file, as `Move` of rclone.
 * @property {boolean} [dirMove] `MOVE` of a folder to a new path, as
 *   `DirMove` of rclone.
 * @property {boolean} [modTime] A `PUT` with `X-OC-Mtime` gives that time
 *   to the file.
 * @property {boolean} [copyModTime] A `COPY` or a `MOVE` with `X-OC-Mtime`
 *   gives that time to the file. By default, the value of `modTime`.
 * @property {boolean} [setModTime] `PATCH` with `X-OC-Mtime` sets the time
 *   of a file, as `SetModTime` of rclone.
 * @property {boolean} [listModTime] The list gives the time of
 *   `X-OC-Mtime`, as `HEAD` does. By default, the value of `modTime`.
 *   s3 keeps the time in the metadata of a file, thus only `HEAD` and `GET`
 *   give it.
 */

/** A time of `X-OC-Mtime`, and its second for `Last-Modified`. */
const MTIME = "1354040105.123456789";
const MTIME_SECOND = "Tue, 27 Nov 2012 18:15:05 GMT";

/**
 * Runs the tests of a backend.
 * @param {string} name The name of the backend, for the report.
 * @param {{ fetch: (request: Request) => Response | Promise<Response> }} backend
 * @param {{
 *   params?: Record<string, string>,
 *   env?: object,
 *   skipName?: RegExp,
 *   writer?: { fetch: (request: Request) => Response | Promise<Response> },
 *   parent?: string,
 *   emptyFolders?: boolean,
 *   type?: string,
 *   features?: Features,
 * }} [options] `params` go in the query of each request, for example the
 *   options of the backend. `env` is the env of the backend, for example
 *   the credentials of s3. The tests skip the names that match `skipName`,
 *   for a limit that the backend has in rclone too. For a backend that is
 *   read only, the PUT and DELETE requests go to `writer`, with no `params`:
 *   a backend that writes the files that the backend under test reads.
 *   `parent` is the folder of the folder of the tests, for example the
 *   bucket `/bucket/` of s3. `emptyFolders` is false for a backend that
 *   cannot have an empty folder, as `CanHaveEmptyDirectories` of rclone:
 *   for example s3 with no folder markers. Then a folder with no file
 *   gives 404, as a folder that does not exist. `type` is the type of the
 *   backend in rclone, for example `s3`: with it, the tests also give the
 *   `params` in the headers `RFETCH_TYPE_NAME` and in the variables
 *   `RCLONE_TYPE_NAME` of `env`. `features` tells what the backend can do
 *   other than GET, HEAD, PUT and DELETE.
 */
export function backendSuite(
  name,
  backend,
  {
    params = {},
    env = {},
    skipName,
    writer,
    parent = "/",
    emptyFolders = true,
    type,
    features = {},
  } = {},
) {
  const root = `${parent}rfetch-test-${randomBytes(6).toString("hex")}/`;
  const fs = remote(backend, { params, root, env });
  if (writer) {
    const { put, delete: remove } = remote(writer, { root });
    Object.assign(fs, { put, delete: remove });
  }
  if (!emptyFolders) {
    // A folder with no file is a folder that does not exist.
    const { list } = fs;
    fs.list = (path) =>
      list(path).catch((error) => {
        if (/ gave 404$/.test(error.message)) return [];
        throw error;
      });
  }

  describe(`backend ${name}`, () => {
    after(async () => {
      // Removes what a test that failed did not remove.
      const response = await fs.delete("");
      await response.body?.cancel();
    });

    it("gives 404 for a folder that does not exist", async () => {
      await expect(fs.get(""), 404);
    });

    it("makes a folder with PUT", async () => {
      await put("", new Uint8Array(0));
      if (!emptyFolders) return;

      const response = await fs.get("");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("Content-Type"), /^text\/html\b/);
      await response.body?.cancel();
      assert.deepEqual(await fs.list(""), [], "a new folder is empty");
    });

    it("gives 404 for a file or a folder that does not exist", async () => {
      await expect(fs.get("missing.txt"), 404);
      await expect(fs.head("missing.txt"), 404);
      await expect(fs.delete("missing.txt"), 404);
      await expect(fs.get("missing/"), 404);
      await expect(fs.delete("missing/"), 404);
      await expect(fs.get("missing/missing.txt"), 404);
    });

    it("puts and gets a file of 0 bytes", async () => {
      const start = Date.now();
      await put("zero.txt", new Uint8Array(0));
      const end = Date.now();

      await assertFile("zero.txt", new Uint8Array(0), start, end);
      await expect(fs.delete("zero.txt"), 204);
      assert.deepEqual(await fs.list(""), []);
    });

    describe("names", () => {
      for (const name of NAMES) {
        const skip = skipName?.test(name) && "a limit of the backend in rclone";
        it(`keeps the name ${JSON.stringify(name)}`, { skip }, async () => {
          // The name is a folder and a file in it.
          const path = `${name}/${name}`;
          // The name has no extension. A server can guess the type of the
          // file from its bytes, as `rclone serve webdav` does, and random
          // bytes can look like text. The bytes 0 to 63 are not text, and
          // they are not the start of a known type of file.
          const content = Uint8Array.from({ length: 64 }, (_, i) => i);
          try {
            const start = Date.now();
            await put(path, content);
            const end = Date.now();

            assertEntries(await fs.list(""), [folder(name)]);
            assertEntries(await fs.list(`${name}/`), [
              file(name, content.length),
            ]);
            await assertFile(path, content, start, end);

            await expect(fs.delete(`${name}/`), 204);
            assertEntries(await fs.list(""), []);
          } catch (error) {
            // The next tests do not see the files of this test.
            await fs.delete(`${name}/`).then((response) =>
              response.body?.cancel()
            );
            throw error;
          }
        });
      }
    });

    describe("files", () => {
      const files = [
        { path: FILE1, content: random(100), start: 0, end: 0 },
        // A file of more than one read of 64 KiB.
        { path: FILE2, content: random(200 * 1024 + 1), start: 0, end: 0 },
      ];
      const [file1, file2] = files;

      it("puts the files", async () => {
        for (const file of files) {
          file.start = Date.now();
          await put(file.path, file.content);
          file.end = Date.now();
        }
      });

      it("lists each folder", async () => {
        assertEntries(await fs.list(""), [
          file(FILE1, file1.content.length),
          folder("hello? sausage"),
        ]);

        // Each folder above z.txt has one folder, then z.txt.
        const names = FILE2.split("/");
        for (let i = 1; i < names.length; i++) {
          const path = `${names.slice(0, i).join("/")}/`;
          const name = names[i];
          const entry = i < names.length - 1
            ? folder(name)
            : file(name, file2.content.length);
          assertEntries(await fs.list(path), [entry]);
        }
      });

      it("gets each file, with its headers", async () => {
        for (const { path, content, start, end } of files) {
          await assertFile(path, content, start, end);
        }
      });

      it("gives a range of a file", async () => {
        const { path, content } = file2;
        const size = content.length;
        for (
          const [header, start, end] of [
            ["bytes=0-0", 0, 0],
            ["bytes=0-99", 0, 99],
            // The ends of the blocks and of the chunks of 64 KiB.
            ["bytes=65535-65536", 65535, 65536],
            ["bytes=65536-131071", 65536, 131071],
            ["bytes=100-", 100, size - 1],
            [`bytes=${size - 1}-`, size - 1, size - 1],
            ["bytes=-1", size - 1, size - 1],
            ["bytes=-70000", size - 70000, size - 1],
            ["bytes=-999999", 0, size - 1],
            ["bytes=150000-999999", 150000, size - 1],
          ]
        ) {
          const response = await fs.get(path, { Range: header });
          assert.equal(response.status, 206, header);
          assert.equal(
            response.headers.get("Content-Range"),
            `bytes ${start}-${end}/${size}`,
            header,
          );
          assert.equal(
            response.headers.get("Content-Length"),
            `${end - start + 1}`,
            header,
          );
          const bytes = new Uint8Array(await response.arrayBuffer());
          assert.ok(
            Buffer.from(bytes).equals(content.subarray(start, end + 1)),
            `the bytes of the range ${header}`,
          );
        }
      });

      it("gives 416 for a range with no byte of the file", async () => {
        const size = file2.content.length;
        const response = await fs.get(file2.path, { Range: `bytes=${size}-` });
        await response.body?.cancel();
        assert.equal(response.status, 416);
        assert.equal(response.headers.get("Content-Range"), `bytes */${size}`);
      });

      it("gives all the file for a range that it does not read", async () => {
        for (const header of ["bytes=5-1", "bytes=0-1,5-6", "items=0-1"]) {
          const response = await fs.get(file1.path, { Range: header });
          assert.equal(response.status, 200, header);
          const bytes = new Uint8Array(await response.arrayBuffer());
          assert.ok(Buffer.from(bytes).equals(file1.content), header);
        }
      });

      it("gives the headers and no body for HEAD", async () => {
        for (const { path, content } of files) {
          const response = await fs.head(path);
          assert.equal(response.status, 200, `HEAD ${JSON.stringify(path)}`);
          assert.equal(response.body, null, "HEAD gives no body");
          assert.equal(response.headers.get("Content-Type"), mimeType(path));
          assert.equal(
            response.headers.get("Content-Length"),
            `${content.length}`,
          );
          assert.ok(response.headers.get("Last-Modified"));
        }

        const response = await fs.head("");
        assert.equal(response.status, 200, "HEAD of a folder");
        assert.equal(response.body, null, "HEAD gives no body");
        assert.match(response.headers.get("Content-Type"), /^text\/html\b/);
      });

      it("puts a file over a file", async () => {
        file1.content = random(200);
        file1.start = Date.now();
        const response = await fs.put(file1.path, file1.content);
        file1.end = Date.now();
        assert.ok(
          response.ok,
          `PUT over a file gave ${response.status}, not 2xx`,
        );
        await response.body?.cancel();

        await assertFile(file1.path, file1.content, file1.start, file1.end);
        assertEntries(await fs.list(""), [
          file(FILE1, file1.content.length),
          folder("hello? sausage"),
        ]);
      });

      it("deletes a file", async () => {
        await expect(fs.delete(file2.path), 204);
        await expect(fs.get(file2.path), 404);
        const parent = file2.path.slice(0, file2.path.lastIndexOf("/") + 1);
        assertEntries(await fs.list(parent), []);
      });

      it("deletes a folder and all that is in it", async () => {
        await put("hello? sausage/êé/a.txt", random(10));
        await expect(fs.delete("hello? sausage/"), 204);
        await expect(fs.get("hello? sausage/"), 404);
        await expect(fs.get("hello? sausage/êé/"), 404);
        await expect(fs.get("hello? sausage/êé/a.txt"), 404);
        assertEntries(await fs.list(""), [file(FILE1, file1.content.length)]);
      });
    });

    describe("COPY, MOVE and the time of a file", () => {
      const {
        copy = false,
        move = false,
        dirMove = false,
        modTime = false,
        copyModTime = modTime,
        setModTime = false,
        listModTime = modTime,
      } = features;
      const content = random(300);
      /** The headers of a request with the time of `MTIME`. */
      const timed = modTime ? { "X-OC-Mtime": MTIME } : {};
      const copyTimed = copyModTime ? { "X-OC-Mtime": MTIME } : {};
      /**
       * Sends a COPY or a MOVE, to a path in the folder of the tests.
       * @param {"COPY" | "MOVE"} method
       * @param {string} path
       * @param {string} target
       */
      const send = (method, path, target) =>
        fs.send(path, {
          method,
          headers: { Destination: fs.url(target).pathname, ...copyTimed },
        });
      /**
       * Makes sure that a file has the content, and the time of `MTIME`.
       * @param {string} path
       * @param {boolean} [time] False for no check of the time.
       */
      const assertCopy = async (path, time = copyModTime) => {
        const response = await fs.get(path);
        assert.equal(response.status, 200, `GET ${path}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        assert.ok(Buffer.from(bytes).equals(content), `the bytes of ${path}`);
        if (!time) return;
        assert.equal(response.headers.get("Last-Modified"), MTIME_SECOND);
        if (!listModTime) return;
        const slash = path.lastIndexOf("/") + 1;
        const entry = (await fs.list(path.slice(0, slash)))
          .find((entry) => entry.Name === path.slice(slash));
        assert.equal(
          Math.floor(Date.parse(entry?.ModTime ?? "") / 1000),
          1354040105,
          `the time of ${path} in the list is ${entry?.ModTime}`,
        );
      };

      it("puts a file with the time of X-OC-Mtime", async () => {
        const response = await fs.put("time/a.txt", content, timed);
        await response.body?.cancel();
        assert.equal(response.status, 201);
        if (modTime) {
          assert.equal(response.headers.get("X-OC-Mtime"), "accepted");
        }
        await assertCopy("time/a.txt", modTime);
      });

      it("sets the time of a file with PATCH", async () => {
        const response = await fs.send("time/a.txt", {
          method: "PATCH",
          headers: { "X-OC-Mtime": "1354040106" },
        });
        await response.body?.cancel();
        if (!setModTime) {
          assert.ok(
            [403, 405, 501, 502].includes(response.status),
            `PATCH gave ${response.status}, not 405`,
          );
          return;
        }
        assert.equal(response.status, 204);
        assert.equal(response.headers.get("X-OC-Mtime"), "accepted");
        const head = await fs.head("time/a.txt");
        assert.equal(
          head.headers.get("Last-Modified"),
          "Tue, 27 Nov 2012 18:15:06 GMT",
        );
        await expect(
          fs.send("time/missing.txt", {
            method: "PATCH",
            headers: { "X-OC-Mtime": "1354040106" },
          }),
          404,
        );
      });

      it("copies a file with COPY", async () => {
        const response = await send("COPY", "time/a.txt", "copy/b.txt");
        await response.body?.cancel();
        if (!copy) {
          assert.ok(
            [403, 405, 501, 502].includes(response.status),
            `COPY gave ${response.status}, not 405`,
          );
          return;
        }
        assert.equal(response.status, 201, "COPY to a new path");
        if (copyModTime) {
          assert.equal(response.headers.get("X-OC-Mtime"), "accepted");
        }
        await assertCopy("copy/b.txt");
        await expect(fs.head("time/a.txt"), 200);
        // Over a file.
        const again = await send("COPY", "time/a.txt", "copy/b.txt");
        await again.body?.cancel();
        assert.ok(
          again.status === 201 || again.status === 204,
          `COPY over a file gave ${again.status}`,
        );
        await expect(send("COPY", "time/missing.txt", "copy/c.txt"), 404);
      });

      it("moves a file with MOVE", async () => {
        if (!copy) await put("copy/b.txt", content);
        const response = await send("MOVE", "copy/b.txt", "move/c.txt");
        await response.body?.cancel();
        if (!move) {
          assert.ok(
            [403, 405, 501, 502].includes(response.status),
            `MOVE gave ${response.status}, not 405`,
          );
          await expect(fs.delete("copy/"), 204);
          return;
        }
        assert.ok(
          response.status === 201 || response.status === 204,
          `MOVE gave ${response.status}`,
        );
        await expect(fs.get("copy/b.txt"), 404);
        await assertCopy("move/c.txt");
        await expect(send("MOVE", "copy/b.txt", "move/d.txt"), 404);
        // The folder of the file stays.
        await expect(fs.delete("copy/"), 204);
      });

      it("moves a folder with MOVE to a new path", async () => {
        if (!move) await put("move/c.txt", content);
        const response = await send("MOVE", "move/", "moved/folder/");
        await response.body?.cancel();
        if (!dirMove) {
          assert.ok(
            [403, 405, 501, 502].includes(response.status),
            `MOVE of a folder gave ${response.status}, not 405`,
          );
          await expect(fs.delete("move/"), 204);
          return;
        }
        assert.equal(response.status, 201, "MOVE of a folder");
        await expect(fs.get("move/c.txt"), 404);
        const moved = await fs.get("moved/folder/c.txt");
        const bytes = new Uint8Array(await moved.arrayBuffer());
        assert.ok(Buffer.from(bytes).equals(content), "the moved file");
        // A folder does not move over a folder.
        await put("other/x.txt", content);
        await expect(send("MOVE", "other/", "moved/"), 412);
        await expect(fs.get("other/x.txt"), 200);
        await expect(fs.delete("other/"), 204);
        await expect(fs.delete("moved/"), 204);
      });

      it("removes the files of these tests", async () => {
        await expect(fs.delete("time/"), 204);
        assertEntries(await fs.list(""), [file(FILE1, 200)]);
      });
    });

    it("reads the options from the headers and from env", {
      skip: type && Object.keys(params).length ? false : "no options",
    }, async () => {
      /** @type {Record<string, string>} */
      const variables = {};
      for (const [key, value] of Object.entries(params)) {
        variables[`${type.toUpperCase()}_${key.toUpperCase()}`] = value;
      }
      /** @param {string} prefix */
      const named = (prefix) =>
        Object.fromEntries(
          Object.entries(variables).map((
            [key, value],
          ) => [prefix + key, value]),
        );
      // The prefix of rfetch in the headers, and the prefix of rclone in
      // env: both work.
      const byHeaders = remote(backend, {
        root,
        env,
        headers: named("RFETCH_"),
      });
      const byEnv = remote(backend, {
        root,
        env: { ...env, ...named("RCLONE_") },
      });
      const content = random(100);
      if (writer) {
        await expect(fs.put("options.txt", content), 201);
      } else {
        await expect(byHeaders.put("options.txt", content), 201);
      }
      for (const client of [byHeaders, byEnv]) {
        const response = await client.get("options.txt");
        assert.equal(response.status, 200);
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content);
        // The options are not in the query, thus no link has a query.
        const html = await (await client.get("")).text();
        assert.doesNotMatch(html, /href="[^"]*\?/, "a link has options");
      }
      await expect(fs.delete("options.txt"), 204);
    });

    it("deletes the root folder of the tests", async () => {
      await expect(fs.delete(""), 204);
      await expect(fs.get(""), 404);
      await expect(fs.get(FILE1), 404);
    });
  });

  /**
   * Puts a file, or a folder for a path with a `/` at the end, and makes
   * sure that the answer is 201 with the location of the path.
   * @param {string} path
   * @param {Uint8Array} content
   */
  async function put(path, content) {
    const response = await fs.put(path, content);
    await response.body?.cancel();
    assert.equal(response.status, 201, `PUT ${JSON.stringify(path)}`);

    const location = response.headers.get("Content-Location");
    assert.ok(location, `PUT ${JSON.stringify(path)} gave no Content-Location`);
    const url = fs.url(path);
    assert.equal(
      decodeURIComponent(new URL(location, url).pathname),
      decodeURIComponent(url.pathname),
      "Content-Location is the path of the file",
    );
  }

  /**
   * Gets a file and makes sure that its content and its headers are correct,
   * and that the list of its folder has the same size, type and time.
   * @param {string} path
   * @param {Uint8Array} content
   * @param {number} start The time before the PUT, in milliseconds.
   * @param {number} end The time after the PUT, in milliseconds.
   */
  async function assertFile(path, content, start, end) {
    const what = `GET ${JSON.stringify(path)}`;
    const response = await fs.get(path);
    assert.equal(response.status, 200, what);

    const { headers } = response;
    assert.equal(headers.get("Content-Type"), mimeType(path), what);
    assert.equal(headers.get("Content-Length"), `${content.length}`, what);
    assert.equal(headers.get("Accept-Ranges"), "bytes", what);
    const lastModified = Date.parse(headers.get("Last-Modified"));
    assertTime(lastModified, start, end, `Last-Modified of ${what}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.length, content.length, `the size of ${what}`);
    assert.ok(
      Buffer.from(bytes).equals(content),
      `the bytes of ${what} are not the bytes of the PUT`,
    );

    const slash = path.lastIndexOf("/") + 1;
    const name = path.slice(slash);
    const entry = (await fs.list(path.slice(0, slash)))
      .find((entry) => entry.Name === name);
    assert.ok(entry, `the list of the folder has no ${JSON.stringify(name)}`);
    assert.equal(entry.Size, content.length, `the size of ${name} in the list`);
    assert.equal(entry.MimeType, mimeType(name), `the type of ${name}`);
    const modTime = Date.parse(entry.ModTime);
    assertTime(modTime, start, end, `the time of ${name} in the list`);
    // `Last-Modified` has whole seconds. A server can also take the two
    // times at two moments of the PUT: `rclone serve s3` takes
    // `Last-Modified` at the start of the request, and the time of the list
    // at the end of the write. Thus the two times can be in two seconds.
    assert.ok(
      Math.abs(modTime - lastModified) < 1000 + (end - start),
      `the time in the list, ${entry.ModTime}, is not the time of ` +
        `Last-Modified, ${headers.get("Last-Modified")}`,
    );
  }
}

/**
 * Sends a request, and makes sure that the answer has the status.
 * @param {Promise<Response>} request
 * @param {number} status
 */
async function expect(request, status) {
  const response = await request;
  await response.body?.cancel();
  assert.equal(response.status, status);
}

/**
 * Makes sure that the entries of a list are the expected entries, in any
 * order. A folder has only its name. A file has its name and its size.
 * @param {import("../listing.js").Entry[]} entries
 * @param {Array<{ Name: string, IsDir: boolean, Size?: number }>} expected
 */
function assertEntries(entries, expected) {
  const actual = entries.map(({ Name, IsDir, Size }) =>
    IsDir ? { Name, IsDir } : { Name, IsDir, Size }
  );
  assert.deepEqual(sort(actual), sort(expected));
}

/**
 * The time of a file must be between the times before and after its PUT.
 * Some backends keep the time to the second, thus the time can be one
 * second before.
 * @param {number} time
 * @param {number} start
 * @param {number} end
 * @param {string} what
 */
function assertTime(time, start, end, what) {
  // `Last-Modified` has whole seconds, and the clock of a file system can be
  // some milliseconds behind `Date.now()`: thus the second of the time can
  // start before the second of `start`.
  const first = Math.floor((start - 100) / 1000) * 1000;
  assert.ok(
    time >= first - 1000 && time <= end + 1000,
    `${what} is ${new Date(time).toISOString()}, not between ` +
      `${new Date(start).toISOString()} and ${new Date(end).toISOString()}`,
  );
}

/** @param {string} Name */
function folder(Name) {
  return { Name, IsDir: true };
}

/** @param {string} Name @param {number} Size */
function file(Name, Size) {
  return { Name, IsDir: false, Size };
}

/** @template {{ Name: string }} T @param {T[]} entries */
function sort(entries) {
  return entries.toSorted((a, b) => a.Name < b.Name ? -1 : +(a.Name > b.Name));
}

/** @param {number} size */
function random(size) {
  return new Uint8Array(randomBytes(size));
}
