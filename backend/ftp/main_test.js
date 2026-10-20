/**
 * The tests of the ftp backend: the shared tests on `rclone serve ftp`,
 * and on pyftpdlib with no TLS, with explicit FTPS and with implicit FTPS;
 * the check of the certificate; LIST in place of MLSD; and the comparison
 * with the ftp backend of rclone on the same servers. See `testing.js` for
 * the tools that the tests need.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { obscure } from "@rfetch/lib/obscure";
import { backendSuite } from "@rfetch/lib/testing/suite";
import { remote } from "@rfetch/lib/testing/remote";
// Sets the global `fetch` that reads the paths of remotes.
import { lsjson } from "../../mod.js";
import ftp from "./main.js";
import {
  hasOpenSSL,
  hasPyftpdlib,
  hasRclone,
  LOGIN,
  servePyftpdlib,
  serveRclone,
} from "./testing.js";

const RCLONE = process.env.RCLONE || "rclone";

/** The password of the test servers, obscured as in the config of rclone. */
const pass = await (await obscure(LOGIN.pass)).text();

/**
 * Runs a command, with no spawnSync: the server is another process, but
 * the tests wait for the command with no block.
 * @param {string} file
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
function run(file, args, env = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: "/nonexistent", TZ: "UTC", ...env },
    }, (error, stdout, stderr) =>
      resolve({
        status: error ? Number(error.code ?? 1) || 1 : 0,
        stdout,
        stderr,
      }));
  });
}

/**
 * The parameters of a test server.
 * @param {import("./testing.js").TestServer} server
 * @param {Record<string, string>} [more]
 * @returns {Record<string, string>}
 */
function paramsOf(server, more = {}) {
  return {
    host: server.host,
    port: `${server.port}`,
    user: LOGIN.user,
    pass,
    ...more,
  };
}

/**
 * A remote of rfetch and of rclone for a test server.
 * @param {Record<string, string>} params
 * @param {string} path
 */
function locationOf(params, path) {
  const options = Object.entries(params).map(([name, value]) =>
    `${name}='${value}'`
  ).join(",");
  return `:ftp,${options}:${path}`;
}

/** The features of a server with no MFMT, as `rclone serve ftp`. */
const NO_TIME = { move: true, dirMove: true };
/** The features of a server with MFMT. */
const TIME = { move: true, dirMove: true, modTime: true, setModTime: true };

if (hasRclone) {
  const plain = await serveRclone();
  after(() => plain.stop());

  backendSuite("ftp", ftp, {
    type: "ftp",
    params: paramsOf(plain),
    features: NO_TIME,
  });
  backendSuite("ftp with one connection", ftp, {
    params: paramsOf(plain, { concurrency: "1", idle_timeout: "0" }),
    features: NO_TIME,
  });

  describe("ftp", () => {
    const params = paramsOf(plain);
    const fs = remote(ftp, { params, root: "/ftp-test/" });

    test("gives 403 for a wrong password", async () => {
      const wrong = await (await obscure("wrong")).text();
      const response = await remote(ftp, { params: { ...params, pass: wrong } })
        .get("");
      await response.body?.cancel();
      assert.equal(response.status, 403);
    });

    test("puts no secret in the links of a list", async () => {
      await fs.put("a b.txt", new TextEncoder().encode("a")).then((r) =>
        r.body?.cancel()
      );
      const html = await fs.get("").then((response) => response.text());
      assert.ok(html.includes(' href="a%20b.txt?host='));
      assert.ok(!html.includes("pass="), "the password is in a link");
      assert.ok(!html.includes("user="), "the user is in a link");
    });

    test("gives 400 and 501 for options that are not correct", async () => {
      for (
        const [options, status] of [
          [{ host: "" }, 400],
          [{ port: "70000" }, 400],
          [{ tls: "true", explicit_tls: "true" }, 400],
          [{ concurrency: "-1" }, 400],
          [{ idle_timeout: "1 minute" }, 400],
          [{ encoding: "Nothing" }, 400],
          [{ socks_proxy: "localhost:1080" }, 501],
          [{ ask_password: "true" }, 501],
        ]
      ) {
        const response = await remote(ftp, {
          params: { ...params, ...options },
        }).get("");
        await response.body?.cancel();
        assert.equal(response.status, status, JSON.stringify(options));
      }
    });

    test("gives 501 for COPY", async () => {
      const response = await fs.send("a b.txt", {
        method: "COPY",
        headers: { Destination: fs.url("c.txt").pathname },
      });
      await response.body?.cancel();
      assert.equal(response.status, 501);
    });

    test("sends no line break in a command", async () => {
      // The encoding always changes a CR and an LF: a name cannot add a
      // command, as in rclone.
      const response = await fs.put(
        "a\r\nDELE a b.txt",
        new TextEncoder().encode("x"),
        { "Content-Length": "1" },
      );
      await response.body?.cancel();
      assert.equal(response.status, 201);
      const names = (await fs.list("")).map(({ Name }) => Name).sort();
      assert.deepEqual(names, ["a\r\nDELE a b.txt", "a b.txt"]);
      const theirs = await fs.get("a b.txt");
      assert.equal(await theirs.text(), "a");
    });

    test("reads a path from the root of the server", async () => {
      // The login folder of rclone serve ftp is the root of the server.
      await fs.put("root.txt", new TextEncoder().encode("root"));
      const response = await fetch(locationOf(params, "/ftp-test/root.txt"));
      assert.equal(await response.text(), "root");
    });

    test("stops a download in the middle, and uses the server again", async () => {
      const data = new Uint8Array(4 << 20).map((_, i) => i * 7);
      await fs.put("big.bin", data).then((r) => r.body?.cancel());
      for (let i = 0; i < 3; i++) {
        const response = await fs.get("big.bin");
        const reader = /** @type {ReadableStream} */ (response.body)
          .getReader();
        await reader.read();
        await reader.cancel();
      }
      const response = await fs.get("big.bin", { Range: "bytes=1000-1999" });
      assert.equal(response.status, 206);
      assert.deepEqual(
        new Uint8Array(await response.arrayBuffer()),
        data.subarray(1000, 2000),
      );
    });

    test("deletes the files of the tests", async () => {
      const response = await fs.delete("");
      assert.equal(response.status, 204);
    });

    describe("and rclone", () => {
      /** The same remote for rclone and for rfetch. */
      const location = (path = "") => locationOf(params, `both/${path}`);

      test("rclone reads the files of rfetch", async () => {
        for (
          const [path, text] of [["a.txt", "hello"], ["d/b c.txt", "world!"]]
        ) {
          const response = await fetch(location(path.replace(" ", "%20")), {
            method: "PUT",
            body: text,
          });
          assert.equal(response.status, 201);
        }
        const { status, stdout, stderr } = await run(RCLONE, [
          "lsjson",
          "-R",
          "--files-only",
          location(),
        ]);
        assert.equal(status, 0, stderr);
        assert.deepEqual(
          JSON.parse(stdout).map(({ Path, Size }) => [Path, Size]).sort(),
          [["a.txt", 5], ["d/b c.txt", 6]],
        );
        assert.equal(
          (await run(RCLONE, ["cat", location("d/b c.txt")])).stdout,
          "world!",
        );
      });

      test("rfetch reads the files and the times of rclone", async () => {
        const { status, stderr } = await run(RCLONE, [
          "copyto",
          fileURLToPath(new URL("./package.json", import.meta.url)),
          location("c/new.json"),
        ]);
        assert.equal(status, 0, stderr);
        const listed = await (await lsjson(location(), { recursive: true }))
          .json();
        const theirList = JSON.parse(
          (await run(RCLONE, ["lsjson", "-R", location()])).stdout,
        );
        const shape = (list) =>
          list.map(({ Path, Size, IsDir, ModTime }) => [
            Path,
            Size,
            IsDir,
            IsDir ? "" : Date.parse(ModTime),
          ]).sort();
        assert.deepEqual(shape(listed), shape(theirList));
      });

      test("rfetch and rclone encode the names in the same way", async () => {
        // The default encoding changes a control character and a space at
        // the end.
        for (const name of ["a%0Bb.txt", "c%20"]) {
          const response = await fetch(location(`names/${name}`), {
            method: "PUT",
            body: "x",
          });
          assert.equal(response.status, 201);
        }
        // rclone shows a control character as its picture.
        const theirs = JSON.parse(
          (await run(RCLONE, ["lsjson", location("names")])).stdout,
        );
        assert.deepEqual(theirs.map(({ Name }) => Name).sort(), [
          "a␋b.txt",
          "c ",
        ]);
        const ours = await (await lsjson(location("names"))).json();
        assert.deepEqual(ours.map(({ Name }) => Name).sort(), [
          "a\u000bb.txt",
          "c ",
        ]);
        await fetch(location(""), { method: "DELETE" }).then((r) =>
          r.body?.cancel()
        );
      });
    });
  });
} else {
  test("ftp with rclone", {
    skip: "rclone is not installed. Set RCLONE to the path of rclone.",
  });
}

if (hasPyftpdlib && hasOpenSSL) {
  const plain = await servePyftpdlib();
  const secure = await servePyftpdlib({ tls: "explicit" });
  const implicit = await servePyftpdlib({ tls: "implicit" });
  after(() => {
    plain.stop();
    secure.stop();
    implicit.stop();
  });

  backendSuite("ftp on pyftpdlib", ftp, {
    params: paramsOf(plain),
    features: TIME,
  });
  // The certificates of the test servers are signed by themselves.
  backendSuite("ftp on pyftpdlib with implicit TLS", ftp, {
    params: paramsOf(implicit, { tls: "true", no_check_certificate: "true" }),
    features: TIME,
  });
  backendSuite("ftp on pyftpdlib with explicit TLS", ftp, {
    params: paramsOf(secure, {
      explicit_tls: "true",
      no_check_certificate: "true",
    }),
    features: TIME,
  });
  backendSuite("ftp on pyftpdlib with TLS 1.2 and no EPSV", ftp, {
    params: paramsOf(secure, {
      explicit_tls: "true",
      no_check_certificate: "true",
      disable_tls13: "true",
      disable_epsv: "true",
      tls_cache_size: "0",
    }),
    features: TIME,
  });

  describe("ftp on pyftpdlib", () => {
    test("refuses a certificate that it does not trust", async () => {
      const response = await remote(ftp, {
        params: paramsOf(implicit, { tls: "true" }),
      }).get("");
      const text = await response.text();
      assert.equal(response.status, 502);
      assert.match(text, /certificate/i);
    });

    test("trusts the certificate of a known authority", async () => {
      // The authorities of Node.js come at its start: another process
      // trusts the certificate of the test server. The data connections
      // also check it.
      const main = fileURLToPath(new URL("./main.js", import.meta.url));
      const query = new URLSearchParams(
        paramsOf(implicit, { host: "localhost", tls: "true" }),
      );
      const script = `
        const { default: ftp } = await import(${JSON.stringify(main)});
        const request = new Request("http://rfetch.test/?${query}");
        const response = await ftp.fetch(request);
        process.stdout.write(response.status + " " + await response.text());
      `;
      const { stdout, stderr } = await run(
        process.execPath,
        ["--input-type=module", "-e", script],
        { NODE_EXTRA_CA_CERTS: /** @type {string} */ (implicit.cert) },
      );
      assert.match(stdout, /^200 /, stderr);
    });

    test("refuses explicit TLS with a certificate that it does not trust", async () => {
      const response = await remote(ftp, {
        params: paramsOf(secure, { explicit_tls: "true" }),
      }).get("");
      const text = await response.text();
      assert.equal(response.status, 502);
      assert.match(text, /certificate/i);
    });

    test("downloads a large file with TLS, then uses the connection again", async () => {
      // More than 1 MiB waits in the client: the data connection pauses.
      const data = new Uint8Array(4 << 20).map((_, i) => i * 13);
      for (
        const params of [
          paramsOf(implicit, { tls: "true", no_check_certificate: "true" }),
          paramsOf(secure, {
            explicit_tls: "true",
            no_check_certificate: "true",
          }),
        ]
      ) {
        const fs = remote(ftp, { params, root: "/ftp-large/" });
        const put = await fs.put("big.bin", data);
        await put.body?.cancel();
        assert.equal(put.status, 201);
        const response = await fs.get("big.bin");
        const reader = /** @type {ReadableStream} */ (response.body)
          .getReader();
        /** @type {Uint8Array[]} */
        const chunks = [];
        for (
          let read = await reader.read();
          !read.done;
          read = await reader.read()
        ) {
          chunks.push(read.value);
          // A slow reader: the server ends the transfer while the client
          // waits.
          if (chunks.length === 1) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
        assert.deepEqual(
          new Uint8Array(await new Blob(chunks).arrayBuffer()),
          data,
        );
        assert.equal((await fs.delete("")).status, 204);
      }
    });

    test("does not sign in with no TLS when the server wants TLS", async () => {
      const response = await remote(ftp, { params: paramsOf(secure) }).get("");
      await response.body?.cancel();
      assert.ok(response.status >= 400, `${response.status}`);
    });

    test("lists with LIST, and gives the time with MDTM", async () => {
      const fs = remote(ftp, {
        params: paramsOf(plain, { disable_mlsd: "true" }),
        root: "/ftp-list/",
      });
      const put = await fs.put("d/a b.txt", new TextEncoder().encode("hello"), {
        "X-OC-Mtime": "1354040105",
      });
      await put.body?.cancel();
      assert.equal(put.status, 201);
      assert.equal(put.headers.get("X-OC-Mtime"), "accepted");
      const entries = await fs.list("d/");
      assert.deepEqual(
        entries.map(({ Name, Size, IsDir, ModTime }) => ({
          Name,
          Size,
          IsDir,
          ModTime,
        })),
        // The times of LIST are not exact: the list has no time.
        [{ Name: "a b.txt", Size: 5, IsDir: false, ModTime: "" }],
      );
      assert.deepEqual(
        (await fs.list("")).map(({ Name, IsDir }) => [Name, IsDir]),
        [["d", true]],
      );
      const response = await fs.get("d/a b.txt");
      assert.equal(
        response.headers.get("Last-Modified"),
        "Tue, 27 Nov 2012 18:15:05 GMT",
      );
      assert.equal(await response.text(), "hello");
      const moved = await fs.send("d/a b.txt", {
        method: "MOVE",
        headers: { Destination: fs.url("e/f.txt").pathname },
      });
      await moved.body?.cancel();
      assert.equal(moved.status, 201);
      assert.equal((await fs.get("e/f.txt")).status, 200);
      assert.equal((await fs.delete("")).status, 204);
    });

    describe("and rclone", {
      skip: !hasRclone && "rclone is not installed",
    }, () => {
      const params = paramsOf(plain);
      /** The same remote for rclone and for rfetch. */
      const location = (path = "") => locationOf(params, `both/${path}`);

      test("rfetch and rclone use the same implicit TLS", async () => {
        const secureParams = paramsOf(implicit, {
          tls: "true",
          no_check_certificate: "true",
        });
        const response = await fetch(locationOf(secureParams, "tls/a.txt"), {
          method: "PUT",
          body: "secret",
        });
        assert.equal(response.status, 201);
        const { status, stdout, stderr } = await run(RCLONE, [
          "cat",
          locationOf(secureParams, "tls/a.txt"),
        ]);
        assert.equal(status, 0, stderr);
        assert.equal(stdout, "secret");
        await fetch(locationOf(secureParams, "tls/"), { method: "DELETE" })
          .then((r) => r.body?.cancel());
      });

      test("rclone reads the times of rfetch", async () => {
        const response = await fetch(location("a.txt"), {
          method: "PUT",
          headers: { "X-OC-Mtime": "1354040105.5" },
          body: "hello",
        });
        assert.equal(response.status, 201);
        assert.equal(response.headers.get("X-OC-Mtime"), "accepted");
        const { status, stdout, stderr } = await run(RCLONE, [
          "lsjson",
          location(),
        ]);
        assert.equal(status, 0, stderr);
        assert.deepEqual(
          JSON.parse(stdout).map(({ Path, Size, ModTime }) => [
            Path,
            Size,
            ModTime,
          ]),
          [["a.txt", 5, "2012-11-27T18:15:05Z"]],
        );
      });

      test("rfetch reads the times of rclone", async () => {
        const { status, stderr } = await run(RCLONE, [
          "touch",
          "--timestamp",
          "2020-01-02T03:04:05",
          location("new.txt"),
        ]);
        assert.equal(status, 0, stderr);
        const listed = await (await lsjson(location())).json();
        const item = listed.find((item) => item.Path === "new.txt");
        assert.equal(
          Date.parse(item?.ModTime),
          Date.parse("2020-01-02T03:04:05Z"),
        );
        const response = await fetch(location("new.txt"), { method: "HEAD" });
        assert.equal(
          response.headers.get("Last-Modified"),
          "Thu, 02 Jan 2020 03:04:05 GMT",
        );
        await fetch(location(""), { method: "DELETE" }).then((r) =>
          r.body?.cancel()
        );
      });
    });
  });
} else {
  test("ftp with pyftpdlib", {
    skip:
      "pyftpdlib, pyOpenSSL or openssl is not installed. Set PYFTPDLIB_PYTHON to a Python with pyftpdlib and pyOpenSSL.",
  });
}
