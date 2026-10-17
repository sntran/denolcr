import { test } from "node:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import fc from "fast-check";

import { config as configure, config_dir, NAME_REGEX } from "./main.js";

// Each test file runs in its own process. These tests use a new folder as the
// current folder and as the home folder. Thus they do not change the files of
// the person, or the rclone.conf of other tests that run at the same time.
const folder = await mkdtemp(join(tmpdir(), "rfetch-config-"));
process.chdir(folder);
process.env.HOME = folder;
delete process.env.XDG_CONFIG_HOME;
delete process.env.APPDATA;

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
        fc.pre(!NAME_REGEX.test(name));

        const response = await configure(command, name, {
          type: "local",
        });

        assert(
          !response.ok,
          "name may only contain letters, numbers, _, -, ., +, @ and space, but not start with - or space, and not end with space",
        );
      }),
    );

    let response = await configure(command, "source", {
      type: "local",
    });

    config = await readFile("rclone.conf", { encoding: "utf8" });
    assert.deepEqual(
      config,
      "[source]\ntype = local\n",
      "should have the new remote added",
    );
    assert.deepEqual(
      await response.text(),
      "[source]\ntype = local",
      "should return the new remote in response",
    );

    // Adds another remote
    response = await configure(command, "target", {
      type: "local",
    });

    config = await readFile("rclone.conf", { encoding: "utf8" });
    assert.deepEqual(
      config,
      "[source]\ntype = local\n\n[target]\ntype = local\n",
      "should have both remotes",
    );
    assert.deepEqual(
      await response.text(),
      `[target]\ntype = local`,
      "should have only the new remote in response",
    );
  });

  await t.test("the same names as rclone", () => {
    for (const name of ["a", "a b", "a-b", "a.b+c@d", "_", "世界", "é1"]) {
      assert.ok(NAME_REGEX.test(name), name);
    }
    for (const name of ["", " a", "-a", "a ", "a\nb", "a:b", "a/b", "a=b"]) {
      assert.ok(!NAME_REGEX.test(name), JSON.stringify(name));
    }
  });

  await t.test("400 for an option that the file cannot keep", async () => {
    const before = await readFile("rclone.conf", { encoding: "utf8" });
    const response = await configure("create", "broken", {
      type: "local",
      key: "line 1\nline 2",
    });
    assert.equal(response.status, 400);
    assert.equal(await readFile("rclone.conf", { encoding: "utf8" }), before);
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

    response = await configure(command, "toString");
    assert.equal(response.status, 404, "a key of Object is not a remote");

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
      `[source]\ntype = local\n\n${remote}\n`,
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
      "[source]\ntype = local\n",
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

  await t.test("keeps the comments of the person", async () => {
    await writeFile(
      "rclone.conf",
      "# My remotes.\n\n# Old disk.\n[old]\ntype = local\n\n" +
        "[work]\n# The type.\ntype = local\n",
    );
    await configure("create", "new", { type: "memory" });
    await configure("update", "work", { type: "alias", remote: "new:" });
    await configure("delete", "old");
    assert.equal(
      await readFile("rclone.conf", { encoding: "utf8" }),
      "# My remotes.\n\n[work]\n# The type.\ntype = alias\n" +
        "remote = new:\n\n[new]\ntype = memory\n",
    );
    assert.equal(
      await configure("show").then((response) => response.text()),
      await readFile("rclone.conf", { encoding: "utf8" }),
      "show gives the file with the comments",
    );
  });

  // Cleans up
  await unlink("rclone.conf");
  await rm(folder, { recursive: true, force: true });
});
