import { assert, assertEquals } from "./dev_deps.ts";

import { Rclone } from "./main.ts";

Deno.test("fetch", async (t) => {
  await t.step("global", async () => {
    const controller = new AbortController();
    await Deno.serve({
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

  await t.step("TRACE", async (t) => {
    await t.step("/path/to/dir/", async () => {
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
    await Rclone.config("create", "source", {
      type: "local",
    });
    await Rclone.config("create", "target", {
      type: "alias",
      remote: "source:",
    });

    await t.step(":type:", async () => {
      const { status, headers } = await fetch(":local:", {
        method: "TRACE",
      });
      assertEquals(status, 200);
      assertEquals(headers.get("Content-Type"), "message/http");

      assertEquals(headers.get("Via"), "local/1.1");
    });

    await t.step("name:", async () => {
      const { status, headers } = await fetch("source:", {
        method: "TRACE",
      });
      assertEquals(status, 200);
      assertEquals(headers.get("Content-Type"), "message/http");

      assertEquals(headers.get("Via"), "local/1.1 source");
    });

    /** Connection string */
    await t.step("name,param1=value1,param2=value2:", async (t) => {
      const cwd = Deno.cwd();

      await t.step("params from config", async () => {
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

      await t.step(
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

      await t.step(
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

      await t.step(
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

      await t.step(
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

      await t.step("overriden by params in connection string", async () => {
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
    });

    await t.step("Authorization", async (t) => {
      await t.step("user", async () => {
        await Rclone.config("update", "source", {
          user: "sntran",
        });

        const response = await fetch("source:", {
          method: "TRACE",
        });
        const body = await response.text();

        const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) || [];
        const { searchParams } = new URL(url, "file:");
        assert(
          !searchParams.get("user"),
          "should not have `user` in search params",
        );

        const [, base64 = ""] = body.match(/^authorization: Basic\s+(.*)$/m) ||
          [];
        const [user, pass] = atob(base64).split(":");
        assertEquals(
          user,
          "sntran",
          "should have the user from config in Authorization header",
        );
        assert(!pass, "should not have pass in Authorization header");
      });

      await t.step("pass", async () => {
        await Rclone.config("update", "source", {
          user: "sntran",
          pass: "rclone",
        });

        const response = await fetch("source:", {
          method: "TRACE",
        });
        const body = await response.text();

        const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) || [];
        const { searchParams } = new URL(url, "file:");
        assert(
          !searchParams.get("pass"),
          "should not have `pass` in search params",
        );

        const [, base64 = ""] = body.match(/^authorization: Basic\s+(.*)$/m) ||
          [];
        const [user, pass] = atob(base64).split(":");
        assertEquals(
          user,
          "sntran",
          "should have the user from config in Authorization header",
        );
        assertEquals(
          pass,
          "rclone",
          "should have password from config in Authorization header",
        );
      });
    });

    // Tears down
    await Deno.remove("rclone.conf");
    Deno.env.delete("RCLONE_SKIP_LINKS");
    Deno.env.delete("RCLONE_ALIAS_REMOTE");
    Deno.env.delete("RCLONE_CONFIG_TARGET_REMOTE");
  });
});
