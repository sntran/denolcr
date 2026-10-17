import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backendSuite } from "@rfetch/testing/suite";
import backend from "./main.js";

// The backend serves the current folder. The tests use a new folder as the
// current folder, with a secret file next to it, out of the root of the
// backend.
const folder = await mkdtemp(join(tmpdir(), "rfetch-local-"));
const root = join(folder, "root");
await mkdir(root);
await writeFile(join(folder, "secret.txt"), "secret");
process.chdir(root);

backendSuite("local", backend);

describe("local", () => {
  after(() => rm(folder, { recursive: true, force: true }));

  /**
   * @param {string} method
   * @param {string} path
   */
  async function send(method, path) {
    const response = await backend.fetch(
      new Request(`http://rfetch.test${path}`, {
        method,
        body: method === "PUT" ? "evil" : null,
      }),
    );
    await response.body?.cancel();
    return response;
  }

  it("does not go out of its root folder", async () => {
    const paths = [
      "/..%2Fsecret.txt",
      "/a/..%2F..%2Fsecret.txt",
      "/%2E%2E%2Fsecret.txt",
      "/..%2F",
    ];
    for (const path of paths) {
      for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
        const { status } = await send(method, path);
        assert.equal(status, 400, `${method} ${path}`);
      }
    }

    assert.equal(await readFile(join(folder, "secret.txt"), "utf8"), "secret");
    assert.ok((await stat(root)).isDirectory());
  });

  it("does not delete its root folder", async () => {
    const { status } = await send("DELETE", "/");
    assert.equal(status, 403);
    assert.ok((await stat(root)).isDirectory());
  });
});
