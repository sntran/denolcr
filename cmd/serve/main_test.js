import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { obscure } from "@rfetch/lib/obscure";
import { fetch as rfetch } from "../../fetch.js";
import { serve } from "./main.js";

/**
 * Serves a remote over HTTP while `check` runs. `check` gets a function that
 * sends a request with a path and gives the text of the answer, or its
 * status when it is not ok.
 * @param {string} remote
 * @param {(get: (path: string, init?: RequestInit) => Promise<string | number>, url: string) => Promise<void>} check
 * @param {Object} [flags]
 */
async function serving(remote, check, flags = {}) {
  const response = await serve("http", remote, {
    addr: "127.0.0.1:0",
    ...flags,
  });
  const reader = response.body.getReader();
  try {
    const { value } = await reader.read();
    const [url] = new TextDecoder().decode(value).match(/http:\/\/\S+/);
    await check(async (path, init = {}) => {
      const answer = await fetch(new URL(path, url), init);
      return answer.ok ? await answer.text() : answer.status;
    }, url);
  } finally {
    await reader.cancel();
  }
}

/**
 * Sends a request with a method that fetch does not send, and gives its
 * status.
 * @param {string} url
 * @param {string} method
 * @returns {Promise<number | undefined>}
 */
function statusOf(url, method) {
  return new Promise((resolve, reject) => {
    httpRequest(url, { method }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject).end();
  });
}

/** A folder with `b.txt`, and `sub/a.txt` in it. */
async function folder() {
  const root = await mkdtemp(join(tmpdir(), "rfetch-serve-"));
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "b.txt"), "b");
  await writeFile(join(root, "sub", "a.txt"), "a");
  return root;
}

test("serve serves only the folder of the remote", async () => {
  const root = await folder();
  try {
    await serving(join(root, "sub"), async (get) => {
      assert.equal(await get("/a.txt"), "a");
      assert.equal(await get("/b.txt"), 404);
      // The URL parser removes `..`, and a `/` after the decoding is bad.
      assert.equal(await get("/../b.txt"), 404);
      assert.equal(await get("/..%2Fb.txt"), 400);
      assert.equal(await get("/x%2F..%2F..%2Fb.txt"), 400);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serve gives the remote its options of the environment, of the config file and of the flags", async (t) => {
  const root = await folder();
  const config = await mkdtemp(join(tmpdir(), "rfetch-serve-config-"));
  const { XDG_CONFIG_HOME } = process.env;
  t.after(async () => {
    if (XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = XDG_CONFIG_HOME;
    delete process.env.RFETCH_CONFIG_SERVED_TYPE;
    delete process.env.RFETCH_CONFIG_SERVED_REMOTE;
    await rm(root, { recursive: true, force: true });
    await rm(config, { recursive: true, force: true });
  });

  await t.test("the environment", async () => {
    process.env.RFETCH_CONFIG_SERVED_TYPE = "alias";
    process.env.RFETCH_CONFIG_SERVED_REMOTE = `${root}/`;
    await serving("served:sub", async (get) => {
      assert.equal(await get("/a.txt"), "a");
      // A request that fails does not stop the server.
      delete process.env.RFETCH_CONFIG_SERVED_TYPE;
      assert.equal(await get("/a.txt"), 500);
      process.env.RFETCH_CONFIG_SERVED_TYPE = "alias";
      assert.equal(await get("/a.txt"), "a");
    });
  });

  const password = await (await obscure("serve password")).text();

  await t.test("the config file", async () => {
    process.env.XDG_CONFIG_HOME = config;
    await mkdir(join(config, "rfetch"));
    await writeFile(
      join(config, "rfetch", "rfetch.conf"),
      `[secret]\ntype = crypt\nremote = ${root}/encrypted/\npassword = ${password}\n`,
    );
    const put = await rfetch("secret:sub/c.txt", {
      method: "PUT",
      body: "secret c",
    });
    assert.equal(put.status, 201);
    await serving("secret:sub", async (get) => {
      assert.equal(await get("/c.txt"), "secret c");
    });
  });

  await t.test("the flags", async () => {
    await serving(`:crypt,remote='${root}/encrypted/':sub`, async (get) => {
      assert.equal(await get("/c.txt"), "secret c");
    }, { crypt_password: password });
  });
});

test("serve gives lists with no query in the links", async () => {
  const root = await folder();
  try {
    await serving(`:alias,remote='${root}/':`, async (get) => {
      const html = await get("/");
      assert.match(html, /href="sub\/"/);
      assert.match(html, /href="b\.txt"/);
      assert.doesNotMatch(html, /href="[^"]*\?/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serve only reads, as rclone serve http", async () => {
  const root = await folder();
  try {
    await serving(join(root, "sub"), async (get, url) => {
      // TRACE of the fetch of rfetch tells the options of the remote.
      assert.equal(await statusOf(url, "TRACE"), 405);
      assert.equal(await get("/a.txt", { method: "PUT", body: "x" }), 405);
      assert.equal(await get("/a.txt", { method: "DELETE" }), 405);
      assert.equal(await get("/", { method: "DELETE" }), 405);
      assert.equal(await readFile(join(root, "sub", "a.txt"), "utf8"), "a");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a client of serve cannot set an option of the remote", async () => {
  const inside = await mkdtemp(join(tmpdir(), "rfetch-serve-inside-"));
  const outside = await mkdtemp(join(tmpdir(), "rfetch-serve-outside-"));
  await writeFile(join(inside, "a.txt"), "inside");
  await writeFile(join(outside, "a.txt"), "outside");
  try {
    await serving(`:alias,remote='${inside}/':`, async (get) => {
      assert.equal(await get("/a.txt"), "inside");
      // The query of the client is not an option.
      assert.equal(
        await get(`/a.txt?remote=${encodeURIComponent(`${outside}/`)}`),
        "inside",
      );
      // A header of the client is not an option, and tells no remote.
      assert.equal(
        await get("/a.txt", {
          headers: {
            RFETCH_ALIAS_REMOTE: `${outside}/`,
            RCLONE_ALIAS_REMOTE: `${outside}/`,
          },
        }),
        "inside",
      );
    });
  } finally {
    await rm(inside, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
