import { test } from "node:test";
import { assert, assertEquals } from "./dev_deps.js";

import { config } from "./mod.js";

test("fetch", async (t) => {
  await t.test("global", async () => {
    const controller = new AbortController();
    Deno.serve({
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
    }, (_request) => {
      return new Response();
    });
  });

  await t.test("TRACE", async (t) => {
    await t.test("/path/to/dir/", async () => {
      const cwd = Deno.cwd();
      const response = await fetch(cwd, {
        method: "TRACE",
      });
      const { status, headers } = response;

      assertEquals(status, 200);
      assertEquals(headers.get("Content-Type"), "message/http");

      assertEquals(headers.get("Via"), "local/1.1");

      const body = await response.text();
      const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) || [];
      const { pathname } = new URL(url, "file:");

      assertEquals(pathname, cwd);
    });

    // Sets up
    await Deno.writeFile("rclone.conf", new Uint8Array());
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
      assertEquals(status, 200);
      assertEquals(headers.get("Content-Type"), "message/http");

      assertEquals(headers.get("Via"), "local/1.1");
    });

    await t.test("name:", async () => {
      const { status, headers } = await fetch("source:", {
        method: "TRACE",
      });
      assertEquals(status, 200);
      assertEquals(headers.get("Content-Type"), "message/http");

      assertEquals(headers.get("Via"), "local/1.1 source");
    });

    /** Connection string */
    await t.test("name,param1=value1,param2=value2:", async (t) => {
      const cwd = Deno.cwd();

      await t.test("params from config", async () => {
        const response = await fetch("target:", {
          method: "TRACE",
        });
        const { status, headers } = response;

        assertEquals(status, 200);
        assertEquals(headers.get("Content-Type"), "message/http");

        assertEquals(headers.get("Via"), "alias/1.1 target");

        const body = await response.text();
        const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) || [];
        const { pathname, searchParams } = new URL(url, "file:");

        assertEquals(pathname, "/");
        assertEquals(searchParams.get("remote"), `source:`);
      });

      await t.test(
        "overriden by backend generic environment vars",
        async () => {
          Deno.env.set("RCLONE_SKIP_LINKS", "true");
          const response = await fetch("target:", {
            method: "TRACE",
          });
          const body = await response.text();
          const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) ||
            [];
          const { searchParams } = new URL(url, "file:");

          assertEquals(searchParams.get("remote"), `source:`);
          assertEquals(searchParams.get("skip_links"), `true`);
        },
      );

      await t.test(
        "overriden by backend-specific environment vars",
        async () => {
          Deno.env.set("RCLONE_ALIAS_REMOTE", "/tmp/1");
          const response = await fetch("target:", {
            method: "TRACE",
          });
          const body = await response.text();
          const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) ||
            [];
          const { searchParams } = new URL(url, "file:");

          assertEquals(searchParams.get("remote"), `/tmp/1`);
          assert(
            !searchParams.has("alias_remote"),
            "should not have param prefixed with backend type",
          );
        },
      );

      await t.test(
        "overriden by remote specific environment vars",
        async () => {
          Deno.env.set("RCLONE_CONFIG_TARGET_REMOTE", "/tmp/2");
          const response = await fetch("target:", {
            method: "TRACE",
          });
          const body = await response.text();
          const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) ||
            [];
          const { searchParams } = new URL(url, "file:");

          assertEquals(searchParams.get("remote"), `/tmp/2`);
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

          assertEquals(status, 200);
          assertEquals(headers.get("Content-Type"), "message/http");

          assertEquals(headers.get("Via"), "alias/1.1 target");

          const body = await response.text();
          const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) ||
            [];
          const { pathname, searchParams } = new URL(url, "file:");

          assertEquals(pathname, "/");
          assertEquals(searchParams.get("remote"), `'/tmp/3'`);
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

        assertEquals(pathname, "/");
        assertEquals(searchParams.get("remote"), `'${cwd}'`);
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

          assertEquals(pathname, "/");
          assertEquals(searchParams.get("remote"), `':local:${cwd}'`);
        },
      );
    });

    // Tears down
    await Deno.remove("rclone.conf");
    Deno.env.delete("RCLONE_SKIP_LINKS");
    Deno.env.delete("RCLONE_ALIAS_REMOTE");
    Deno.env.delete("RCLONE_CONFIG_TARGET_REMOTE");
  });
});
