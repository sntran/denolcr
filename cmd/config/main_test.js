import { test } from "node:test";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import fc from "fast-check";

import { config as configure, config_dir } from "./main.js";

test("config", async (t) => {
  let command = "file";
  await t.test(command, async () => {
    const configDir = config_dir();
    let path = await configure(command).then((res) => res.text());

    assert.deepEqual(
      path,
      join(configDir, "rclone", "rclone.conf"),
      "should default to config directory",
    );

    await writeFile("rclone.conf", new Uint8Array());
    path = await configure(command).then((res) => res.text());
    assert.deepEqual(
      path,
      "rclone.conf",
      "should use rclone.conf at current directory first",
    );
  });

  command = "create";
  await t.test(command, async () => {
    let config = await readFile("rclone.conf", { encoding: "utf8" });
    assert.deepEqual(config, "", "initial empty config");

    await fc.assert(
      fc.asyncProperty(fc.string(), async (name) => {
        fc.pre(!/^[\w.][\w.\s-]*$/.test(name));

        const response = await configure(command, name, {
          type: "local",
        });

        assert(
          !response.ok,
          "name may only contain 0-9, A-Z, a-z, _, -, . and space, but not start with - or space",
        );
      }),
    );

    let response = await configure(command, "source", {
      type: "local",
    });

    config = await readFile("rclone.conf", { encoding: "utf8" });
    assert.deepEqual(
      config,
      "[source]\ntype = local",
      "should have the new remote added",
    );
    assert.deepEqual(
      await response.text(),
      config,
      "should return the new remote in response",
    );

    // Adds another remote
    response = await configure(command, "target", {
      type: "local",
    });

    config = await readFile("rclone.conf", { encoding: "utf8" });
    assert.deepEqual(
      config,
      "[source]\ntype = local\n\n[target]\ntype = local",
      "should have both remotes",
    );
    assert.deepEqual(
      await response.text(),
      `[target]\ntype = local`,
      "should have only the new remote in response",
    );
  });

  command = "show";
  await t.test(command, async () => {
    const config = await readFile("rclone.conf", { encoding: "utf8" });
    let response = await configure(command);
    assert.deepEqual(
      await response.text(),
      config,
      "should return the full config when name is not specified",
    );

    response = await configure(command, "source");
    assert.deepEqual(
      await response.text(),
      "[source]\ntype = local",
      "should return only remote specified by name",
    );

    response = await configure(command, "target");
    assert.deepEqual(
      await response.text(),
      "[target]\ntype = local",
      "should return only remote specified by name",
    );

    response = await configure(command, "404");
    assert.deepEqual(
      response.status,
      404,
      "should return 404 when remote not found",
    );

    response = await configure(command, "source", undefined, {
      headers: {
        "Accept": "application/json",
      },
    });
    assert(await response.json());
  });

  command = "update";
  await t.test(command, async () => {
    let response = await configure(command, "target", {
      type: "alias",
      remote: "source:",
    });

    const remote = `[target]\ntype = alias\nremote = source:`;

    const config = await readFile("rclone.conf", { encoding: "utf8" });
    assert.deepEqual(
      config,
      `[source]\ntype = local\n\n${remote}`,
      "should have the remote updated",
    );
    assert.deepEqual(
      await response.text(),
      remote,
      "should return the updated remote in response",
    );

    response = await configure(command, "404", {});
    assert.deepEqual(
      response.status,
      404,
      "should return 404 when remote not found",
    );
  });

  command = "dump";
  await t.test(command, async () => {
    const response = await configure(command);
    assert.deepEqual(await response.json(), {
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
  await t.test(command, async () => {
    let response = await configure(command, "target");
    const config = await readFile("rclone.conf", { encoding: "utf8" });
    assert.deepEqual(
      config,
      "[source]\ntype = local",
      "should have the remote deleted",
    );
    assert.deepEqual(
      await response.text(),
      "",
      "should not return the deleted remote in response",
    );

    response = await configure(command, "404");
    assert.deepEqual(
      response.status,
      200,
      "should still return 200 when remote not found",
    );
  });

  // Cleans up
  await unlink("rclone.conf");
});
