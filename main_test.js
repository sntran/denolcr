import { test } from "node:test";
import process from "node:process";
import { mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { serve } from "@sntran/serve";
import assert from "node:assert/strict";

import { listen } from "@rfetch/lib/testing/server";
import { config, fetch } from "./mod.js";

/**
 * Gives an option in the `env` of the backend, from the body of an answer to
 * `TRACE`: the options of the config file and of the variables are not in
 * the query, thus they are never in a link.
 * @param {string} body
 * @param {string} name For example `RFETCH_ALIAS_REMOTE`.
 */
function variableOf(body, name) {
  const line = body.split("\r").find((line) => line.startsWith(`${name}: `));
  return line?.slice(name.length + 2);
}

test("fetch", async (t) => {
  await t.test("global", () => {
    const controller = new AbortController();
    serve({
      fetch: (_request) => new Response(),
      port: 0,
      signal: controller.signal,
      async onListen({ port, hostname }) {
        const url = `http://${hostname}:${port}/`;
        let response = await fetch(url, {
          method: "HEAD",
        });
        assert(response.ok);

        const request = new Request(url, {
          method: "HEAD",
        });
        response = await fetch(request);
        assert(response.ok);

        controller.abort();
      },
    });
  });

  await t.test("TRACE", async (t) => {
    await t.test("/path/to/dir/", async () => {
      const cwd = process.cwd();
      const response = await fetch(cwd, {
        method: "TRACE",
      });
      const { status, headers } = response;

      assert.deepEqual(status, 200);
      assert.deepEqual(headers.get("Content-Type"), "message/http");

      assert.deepEqual(headers.get("Via"), "local/1.1");

      const body = await response.text();
      const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) || [];
      const { pathname } = new URL(url, "file:");

      assert.deepEqual(pathname, cwd);
    });

    // Sets up
    await writeFile("rclone.conf", new Uint8Array());
    await config("create", "source", {
      type: "local",
    });
    await config("create", "target", {
      type: "alias",
      remote: "source:",
    });

    await t.test(":type:", async () => {
      const { status, headers } = await fetch(":local:", {
        method: "TRACE",
      });
      assert.deepEqual(status, 200);
      assert.deepEqual(headers.get("Content-Type"), "message/http");

      assert.deepEqual(headers.get("Via"), "local/1.1");
    });

    await t.test("name:", async () => {
      const { status, headers } = await fetch("source:", {
        method: "TRACE",
      });
      assert.deepEqual(status, 200);
      assert.deepEqual(headers.get("Content-Type"), "message/http");

      assert.deepEqual(headers.get("Via"), "local/1.1 source");
    });

    /** Connection string */
    await t.test("name,param1=value1,param2=value2:", async (t) => {
      const cwd = process.cwd();

      await t.test("params from config", async () => {
        const response = await fetch("target:", {
          method: "TRACE",
        });
        const { status, headers } = response;

        assert.deepEqual(status, 200);
        assert.deepEqual(headers.get("Content-Type"), "message/http");

        assert.deepEqual(headers.get("Via"), "alias/1.1 target");

        const body = await response.text();
        const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) || [];
        const { pathname, searchParams } = new URL(url, "file:");

        assert.deepEqual(pathname, "/");
        assert(!searchParams.has("remote"), "the config is not in the query");
        assert.deepEqual(variableOf(body, "RFETCH_ALIAS_REMOTE"), `source:`);
      });

      await t.test(
        "overriden by backend generic environment vars",
        async () => {
          process.env.RCLONE_SKIP_LINKS = "true";
          const response = await fetch("target:", {
            method: "TRACE",
          });
          const body = await response.text();
          const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) ||
            [];
          const { searchParams } = new URL(url, "file:");

          assert(!searchParams.has("skip_links"), "not in the query");
          assert.deepEqual(variableOf(body, "RFETCH_ALIAS_REMOTE"), `source:`);
          assert.deepEqual(variableOf(body, "RFETCH_ALIAS_SKIP_LINKS"), `true`);
        },
      );

      await t.test(
        "overriden by backend-specific environment vars",
        async () => {
          process.env.RCLONE_ALIAS_REMOTE = "/tmp/1";
          const response = await fetch("target:", {
            method: "TRACE",
          });
          const body = await response.text();
          const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) ||
            [];
          const { searchParams } = new URL(url, "file:");

          assert(!searchParams.has("remote"), "not in the query");
          assert.deepEqual(variableOf(body, "RFETCH_ALIAS_REMOTE"), `/tmp/1`);
          assert(
            !searchParams.has("alias_remote"),
            "should not have param prefixed with backend type",
          );
        },
      );

      await t.test(
        "overriden by remote specific environment vars",
        async () => {
          process.env.RCLONE_CONFIG_TARGET_REMOTE = "/tmp/2";
          const response = await fetch("target:", {
            method: "TRACE",
          });
          const body = await response.text();
          const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) ||
            [];
          const { searchParams } = new URL(url, "file:");

          assert(!searchParams.has("remote"), "not in the query");
          assert.deepEqual(variableOf(body, "RFETCH_ALIAS_REMOTE"), `/tmp/2`);
          assert(
            !searchParams.has("config_target_remote"),
            "should not have param prefixed with remote name",
          );
        },
      );

      await t.test(
        "overriden by flags prefixed with backend type",
        async () => {
          const response = await fetch("target:?alias_remote='/tmp/3'", {
            method: "TRACE",
          });
          const { status, headers } = response;

          assert.deepEqual(status, 200);
          assert.deepEqual(headers.get("Content-Type"), "message/http");

          assert.deepEqual(headers.get("Via"), "alias/1.1 target");

          const body = await response.text();
          const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) ||
            [];
          const { pathname, searchParams } = new URL(url, "file:");

          assert.deepEqual(pathname, "/");
          assert.deepEqual(searchParams.get("remote"), `'/tmp/3'`);
        },
      );

      await t.test("overriden by params in connection string", async () => {
        const response = await fetch(
          `target,remote='${cwd}':?alias_remote='/tmp/3'`,
          {
            method: "TRACE",
          },
        );
        const body = await response.text();
        const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) || [];
        const { pathname, searchParams } = new URL(url, "file:");

        assert.deepEqual(pathname, "/");
        // As in rclone, the quotes are not a part of the value.
        assert.deepEqual(searchParams.get("remote"), cwd);
      });

      await t.test(
        "overriden by params in connection string that is also a connection string",
        async () => {
          const response = await fetch(
            `target,remote=':local,case_sensitive=true:${cwd}':?alias_remote='/tmp/3'`,
            {
              method: "TRACE",
            },
          );
          const body = await response.text();
          const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) ||
            [];
          const { pathname, searchParams } = new URL(url, "file:");

          assert.deepEqual(pathname, "/");
          // The value in quotes can have "," and ":", as in rclone.
          assert.deepEqual(
            searchParams.get("remote"),
            `:local,case_sensitive=true:${cwd}`,
          );
        },
      );
    });

    // Tears down
    await unlink("rclone.conf");
    delete process.env.RCLONE_SKIP_LINKS;
    delete process.env.RCLONE_ALIAS_REMOTE;
    delete process.env.RCLONE_CONFIG_TARGET_REMOTE;
  });
});

test("options in the headers of a request", async (t) => {
  await t.test("a remote only from the headers, with no config file", async () => {
    const headers = { RCLONE_CONFIG_MEM_TYPE: "memory" };
    const put = await fetch("mem:headers/a.txt", {
      method: "PUT",
      body: "from the headers",
      headers,
    });
    assert.equal(put.status, 201);
    const response = await fetch("mem:headers/a.txt", { headers });
    assert.equal(await response.text(), "from the headers");
    // The same remote, as a remote on the fly.
    const plain = await fetch(":memory:headers/a.txt");
    assert.equal(await plain.text(), "from the headers");
    await assert.rejects(fetch("mem:headers/a.txt"), /Remote mem not found/);
  });

  await t.test("a header takes the place of a variable", async () => {
    process.env.RCLONE_CONFIG_PLACE_TYPE = "alias";
    process.env.RCLONE_CONFIG_PLACE_REMOTE = "/tmp/env";
    try {
      const response = await fetch("place:", {
        method: "TRACE",
        headers: { RCLONE_CONFIG_PLACE_REMOTE: "/tmp/header" },
      });
      const body = await response.text();
      assert.equal(variableOf(body, "RFETCH_ALIAS_REMOTE"), "/tmp/header");
    } finally {
      delete process.env.RCLONE_CONFIG_PLACE_TYPE;
      delete process.env.RCLONE_CONFIG_PLACE_REMOTE;
    }
  });

  await t.test("RFETCH_ takes the place of RCLONE_", async () => {
    process.env.RCLONE_CONFIG_BOTH_TYPE = "alias";
    process.env.RCLONE_CONFIG_BOTH_REMOTE = "/tmp/rclone-env";
    process.env.RFETCH_CONFIG_BOTH_REMOTE = "/tmp/rfetch-env";
    try {
      /** @param {HeadersInit} headers */
      const remoteOf = async (headers) => {
        const response = await fetch("both:", { method: "TRACE", headers });
        return variableOf(await response.text(), "RFETCH_ALIAS_REMOTE");
      };
      assert.equal(await remoteOf({}), "/tmp/rfetch-env");
      // A header takes the place of a variable of the process.
      assert.equal(
        await remoteOf({ RCLONE_CONFIG_BOTH_REMOTE: "/tmp/rclone-header" }),
        "/tmp/rclone-header",
      );
      assert.equal(
        await remoteOf({
          RCLONE_CONFIG_BOTH_REMOTE: "/tmp/rclone-header",
          RFETCH_CONFIG_BOTH_REMOTE: "/tmp/rfetch-header",
        }),
        "/tmp/rfetch-header",
      );
    } finally {
      delete process.env.RCLONE_CONFIG_BOTH_TYPE;
      delete process.env.RCLONE_CONFIG_BOTH_REMOTE;
      delete process.env.RFETCH_CONFIG_BOTH_REMOTE;
    }
  });

  await t.test("the variables of other remotes are not options", async () => {
    process.env.RCLONE_CONFIG_OTHER_SECRET_ACCESS_KEY = "other-secret";
    try {
      const response = await fetch(":memory:leak/", {
        method: "TRACE",
        headers: { RCLONE_CONFIG_THIRD_PASSWORD: "third-secret" },
      });
      const body = await response.text();
      assert(!body.includes("RCLONE_MEMORY_CONFIG_"), body);
      const [, url] = body.match(/^TRACE (.*) HTTP\/1.1$/m);
      assert.equal(
        new URL(url, "file:").search,
        "",
        "an option is in the query",
      );

      await fetch(":memory:leak/a.txt", { method: "PUT", body: "a" });
      const html = await (await fetch(":memory:leak/", {
        headers: { RCLONE_CONFIG_THIRD_PASSWORD: "third-secret" },
      })).text();
      assert(!html.includes("other-secret"), "a variable is in a link");
      assert(!html.includes("third-secret"), "a header is in a link");
    } finally {
      delete process.env.RCLONE_CONFIG_OTHER_SECRET_ACCESS_KEY;
    }
  });

  await t.test("no option goes out to a URL", async () => {
    /** @type {Headers[]} */
    const seen = [];
    const server = await listen((request) => {
      seen.push(request.headers);
      return new Response("ok");
    });
    try {
      const headers = {
        RCLONE_S3_SECRET_ACCESS_KEY: "secret",
        RCLONE_CONFIG_R2_TYPE: "s3",
        RFETCH_S3_SECRET_ACCESS_KEY: "secret",
        RFETCH_CONFIG_R2_TYPE: "s3",
        "X-Other": "other",
      };
      await (await fetch(`${server.url}`, { headers })).text();
      await (await fetch(new Request(server.url, { headers }))).text();
      await (await fetch(server.url, { headers })).text();
      assert.equal(seen.length, 3);
      for (const headers of seen) {
        assert.equal(headers.get("x-other"), "other");
        assert.deepEqual(
          [...headers.keys()].filter((name) => /^r(clone|fetch)_/.test(name)),
          [],
        );
      }
    } finally {
      await server.close();
    }
  });

  await t.test("two requests at the same time, each with its own remote", async () => {
    await fetch(":memory:one/a.txt", { method: "PUT", body: "one" });
    await fetch(":memory:two/a.txt", { method: "PUT", body: "two" });
    /** @param {string} folder */
    const get = (folder) =>
      fetch("tenant:a.txt", {
        headers: {
          RCLONE_CONFIG_TENANT_TYPE: "alias",
          RCLONE_CONFIG_TENANT_REMOTE: `:memory:${folder}`,
        },
      }).then((response) => response.text());
    const folders = Array.from({ length: 20 }, (_, i) => i % 2 ? "one" : "two");
    assert.deepEqual(await Promise.all(folders.map(get)), folders);
  });
});

test("local paths", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "rfetch-outside-"));
  await writeFile(join(outside, "secret.txt"), "outside");
  const inside = await mkdtemp(join(tmpdir(), "rfetch-inside-"));
  await writeFile(join(inside, "a.txt"), "inside");
  const cwd = process.cwd();
  process.chdir(inside);
  try {
    await t.test("a path is relative to the current folder", async () => {
      assert.equal(await (await fetch("a.txt")).text(), "inside");
      assert.equal(await (await fetch("./a.txt")).text(), "inside");
    });

    await t.test("an absolute path and ../ go out of the current folder", async () => {
      const file = join(outside, "secret.txt");
      assert.equal(await (await fetch(file)).text(), "outside");
      const up = `../${basename(outside)}/secret.txt`;
      assert.equal(await (await fetch(up)).text(), "outside");
    });

    await t.test("a header, a variable or a remote cannot set the root", async () => {
      const path = `${outside}/secret.txt`;
      let response = await fetch(`:local:${path}`, {
        headers: { RFETCH_LOCAL_ROOT: "/" },
      });
      assert.equal(response.status, 404);
      process.env.RFETCH_LOCAL_ROOT = "/";
      try {
        response = await fetch(`:local:${path}`);
        assert.equal(response.status, 404);
      } finally {
        delete process.env.RFETCH_LOCAL_ROOT;
      }
      response = await fetch(`disk:${path}`, {
        headers: {
          RFETCH_CONFIG_DISK_TYPE: "local",
          RFETCH_CONFIG_DISK_ROOT: "/",
        },
      });
      assert.equal(response.status, 404);
    });

    await t.test("the current folder stays", async () => {
      for (const path of ["./", ".", `${inside}/`, `../${basename(inside)}/`]) {
        const response = await fetch(path, { method: "DELETE" });
        assert.equal(response.status, 403, JSON.stringify(path));
      }
      assert.ok((await stat(join(inside, "a.txt"))).isFile());
    });
  } finally {
    process.chdir(cwd);
    await rm(outside, { recursive: true, force: true });
    await rm(inside, { recursive: true, force: true });
  }
});
