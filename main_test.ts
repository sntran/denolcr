import { config_dir, join } from "./deps.ts";
import {
  assert,
  assertEquals,
  fc,
} from "./dev_deps.ts";

import { Rclone } from "./main.ts";

Deno.test("config", async (t) => {
  let command = "file";
  await t.step(command, async () => {
    const configDir = config_dir()!;
    let path = await Rclone.config(command).then((res) => res.text());

    assertEquals(
      path,
      join(configDir, "rclone", "rclone.conf"),
      "should default to config directory",
    );

    await Deno.writeFile("rclone.conf", new Uint8Array());
    path = await Rclone.config(command).then((res) => res.text());
    assertEquals(
      path,
      "rclone.conf",
      "should use rclone.conf at current directory first",
    );
  });

  command = "create";
  await t.step(command, async () => {
    let config = await Deno.readTextFile("rclone.conf");
    assertEquals(config, "", "initial empty config");

    await fc.assert(
      fc.asyncProperty(fc.string(), async (name: string) => {
        fc.pre(!/^[\w.][\w.\s-]*$/.test(name));

        const response = await Rclone.config(command, name, {
          type: "local",
        });

        assert(!response.ok, "name may only contain 0-9, A-Z, a-z, _, -, . and space, but not start with - or space");
      }
    ));

    let response = await Rclone.config(command, "source", {
      type: "local",
    });

    config = await Deno.readTextFile("rclone.conf");
    assertEquals(
      config,
      "[source]\ntype = local",
      "should have the new remote added",
    );
    assertEquals(
      await response.text(),
      config,
      "should return the new remote in response",
    );

    // Adds another remote
    response = await Rclone.config(command, "target", {
      type: "local",
    });

    config = await Deno.readTextFile("rclone.conf");
    assertEquals(
      config,
      "[source]\ntype = local\n\n[target]\ntype = local",
      "should have both remotes",
    );
    assertEquals(
      await response.text(),
      `[target]\ntype = local`,
      "should have only the new remote in response",
    );
  });

  command = "show";
  await t.step(command, async () => {
    const config = await Deno.readTextFile("rclone.conf");
    let response = await Rclone.config(command);
    assertEquals(
      await response.text(),
      config,
      "should return the full config when name is not specified",
    );

    response = await Rclone.config(command, "source");
    assertEquals(
      await response.text(),
      "[source]\ntype = local",
      "should return only remote specified by name",
    );

    response = await Rclone.config(command, "target");
    assertEquals(
      await response.text(),
      "[target]\ntype = local",
      "should return only remote specified by name",
    );

    response = await Rclone.config(command, "404");
    assertEquals(response.status, 404, "should return 404 when remote not found");

    response = await Rclone.config(command, "source", undefined, {
      headers: {
        "Accept": "application/json",
      },
    });
    assert(await response.json());
  });

  command = "update";
  await t.step(command, async () => {
    let response = await Rclone.config(command, "target", {
      type: "alias",
      remote: "source:",
    });

    const remote = `[target]\ntype = alias\nremote = source:`;

    const config = await Deno.readTextFile("rclone.conf");
    assertEquals(
      config,
      `[source]\ntype = local\n\n${remote}`,
      "should have the remote updated",
    );
    assertEquals(
      await response.text(),
      remote,
      "should return the updated remote in response",
    );

    response = await Rclone.config(command, "404", {});
    assertEquals(response.status, 404, "should return 404 when remote not found");
  });

  command = "dump";
  await t.step(command, async () => {
    const response = await Rclone.config(command);
    assertEquals(await response.json(), {
      source: {
        type: "local",
      },
      target: {
        type: "alias",
        remote: "source:",
      },
    }, "should return the config as JSON");
  });

  command = "delete";
  await t.step(command, async () => {
    let response = await Rclone.config(command, "target");
    const config = await Deno.readTextFile("rclone.conf");
    assertEquals(
      config,
      "[source]\ntype = local",
      "should have the remote deleted",
    );
    assertEquals(
      await response.text(),
      "",
      "should not return the deleted remote in response",
    );

    response = await Rclone.config(command, "404");
    assertEquals(response.status, 200, "should still return 200 when remote not found");
  });

  // Cleans up
  await Deno.remove("rclone.conf");
});

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
      const response  = await fetch(cwd, {
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

      await t.step("overriden by flags prefixed with backend type", async () => {
        const response = await fetch("target:?alias-remote='/tmp'", {
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
        assertEquals(searchParams.get("remote"), `'/tmp'`);
      });

      await t.step("overriden by params in connection string", async () => {
        const response = await fetch(`target,remote='${cwd}':?alias-remote='/tmp'`, {
          method: "TRACE",
        });
        const body = await response.text();
        const [, _method, url] = body.match(/^(TRACE) (.*) HTTP\/1.1$/m) || [];
        const { pathname, searchParams } = new URL(url, "file:");

        assertEquals(pathname, "/");
        assertEquals(searchParams.get("remote"), `'${cwd}'`);
      });

    });

    // Tears down
    await Deno.remove("rclone.conf");
  });
});
