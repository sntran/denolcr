/**
 * The tests of the s3 backend, on `rclone serve s3`: a server of the S3 API
 * on a local folder. They run when rclone is in the PATH, or when RCLONE is
 * the path of rclone.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { backendSuite } from "@rfetch/lib/testing/suite";
import { remote } from "@rfetch/lib/testing/remote";
import { listen } from "@rfetch/lib/testing/server";
import s3 from "./main.js";
import { KEYS, serveS3 } from "./testing.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

if (hasRclone) {
  const server = await serveS3();
  after(() => server.stop());
  const params = { ...KEYS, endpoint: server.endpoint, region: "us-east-1" };

  // S3 has no empty folders with no markers, as rclone.
  backendSuite("s3", s3, { params, parent: "/rfetch/", emptyFolders: false });
  // Files in parts: upload_cutoff of 100 KiB, and parts of 5 MiB.
  backendSuite("s3 in parts", s3, {
    params: { ...params, upload_cutoff: "100k" },
    parent: "/rfetch/",
    emptyFolders: false,
  });

  describe("s3", () => {
    const fs = remote(s3, { params, root: "/rfetch/s3-test/" });

    test("puts no credentials in the links of a list", async () => {
      await fs.put("a b.txt", new TextEncoder().encode("a"));
      const html = await fs.get("").then((response) => response.text());
      assert.ok(html.includes(' href="a%20b.txt?endpoint='));
      assert.ok(!html.includes("rfetch-key"));
      assert.ok(!html.includes("rfetch-secret"));
    });

    test("lists the buckets", async () => {
      const root = remote(s3, { params });
      assert.deepEqual(
        (await root.list("")).map(({ Name, IsDir }) => ({ Name, IsDir })),
        [{ Name: "rfetch", IsDir: true }],
      );
    });

    test("puts a file of unknown size in parts", async () => {
      const size = 5 * 1024 * 1024 + 1000;
      const data = new Uint8Array(size).map((_, i) => (i * 31) & 0xff);
      const response = await fs.send("parts.bin", {
        method: "PUT",
        body: new Blob([data]).stream(),
      });
      assert.equal(response.status, 201);
      const got = await fs.get("parts.bin");
      assert.equal(got.headers.get("Content-Length"), `${size}`);
      assert.deepEqual(new Uint8Array(await got.arrayBuffer()), data);
    });

    test("takes the options from env", async () => {
      const fromEnv = remote(s3, {
        params: { endpoint: server.endpoint },
        env: {
          RCLONE_S3_ACCESS_KEY_ID: KEYS.access_key_id,
          RCLONE_S3_SECRET_ACCESS_KEY: KEYS.secret_access_key,
        },
        root: "/rfetch/s3-test/",
      });
      const response = await fromEnv.get("a b.txt");
      assert.equal(await response.text(), "a");
    });

    test("gives 403 with wrong credentials", async () => {
      const wrong = remote(s3, {
        params: { ...params, secret_access_key: "wrong" },
        root: "/rfetch/s3-test/",
      });
      const response = await wrong.get("a b.txt");
      await response.body?.cancel();
      assert.equal(response.status, 403);
    });

    test("gives 400 for options that are not correct", async () => {
      for (
        const options of [
          { secret_access_key: "" },
          { chunk_size: "1M" },
          { list_chunk: "0" },
          { endpoint: "http://[" },
        ]
      ) {
        const response = await remote(s3, { params: { ...params, ...options } })
          .get("");
        await response.body?.cancel();
        assert.equal(response.status, 400, JSON.stringify(options));
      }
    });

    test("deletes the files of the tests", async () => {
      const response = await fs.delete("");
      assert.equal(response.status, 204);
    });
  });
} else {
  test("s3", { skip: "rclone is not installed. Set RCLONE to its path." });
}

test("puts the markers of the parent folders, as rclone", async () => {
  // A service that keeps the names of the objects, and records the requests.
  const keys = new Set();
  const log = [];
  const server = await listen(async (request) => {
    const { pathname } = new URL(request.url);
    log.push(`${request.method} ${pathname}`);
    await request.body?.cancel();
    if (request.method === "HEAD") {
      return new Response(null, { status: keys.has(pathname) ? 200 : 404 });
    }
    keys.add(pathname);
    return new Response(null, { headers: { ETag: '"0"' } });
  });
  after(() => server.close());

  const params = { endpoint: `${server.url}`, directory_markers: "true" };
  const fs = remote(s3, { params, root: "/bucket/" });
  /** @param {string} path @param {string[]} requests */
  const putGives = async (path, requests) => {
    log.length = 0;
    const response = await fs.put(path, new Uint8Array(0));
    assert.equal(response.status, 201, path);
    assert.deepEqual(log, requests, path);
  };

  await putGives("a/b/c.txt", [
    "HEAD /bucket/a/b/",
    "PUT /bucket/a/b/",
    "HEAD /bucket/a/",
    "PUT /bucket/a/",
    "PUT /bucket/a/b/c.txt",
  ]);
  // The parent folder a/ has a marker.
  await putGives("a/d/e.txt", [
    "HEAD /bucket/a/d/",
    "PUT /bucket/a/d/",
    "HEAD /bucket/a/",
    "PUT /bucket/a/d/e.txt",
  ]);
  await putGives("a/f/", [
    "HEAD /bucket/a/f/",
    "PUT /bucket/a/f/",
    "HEAD /bucket/a/",
  ]);
  await putGives("g.txt", ["PUT /bucket/g.txt"]);

  // With no markers, a file is one PUT.
  log.length = 0;
  const plain = remote(s3, {
    params: { endpoint: `${server.url}` },
    root: "/bucket/",
  });
  assert.equal((await plain.put("h/i.txt", new Uint8Array(0))).status, 201);
  assert.deepEqual(log, ["PUT /bucket/h/i.txt"]);
});

// A run on a real service, for example Cloudflare R2, when S3_TEST_ENDPOINT
// and S3_TEST_BUCKET are set. The credentials are in RCLONE_S3_ACCESS_KEY_ID
// and RCLONE_S3_SECRET_ACCESS_KEY, thus they are not in a URL.
const { S3_TEST_ENDPOINT, S3_TEST_BUCKET, S3_TEST_REGION } = process.env;
if (S3_TEST_ENDPOINT && S3_TEST_BUCKET) {
  const env = {
    RCLONE_S3_ACCESS_KEY_ID: process.env.RCLONE_S3_ACCESS_KEY_ID,
    RCLONE_S3_SECRET_ACCESS_KEY: process.env.RCLONE_S3_SECRET_ACCESS_KEY,
  };
  const params = {
    endpoint: S3_TEST_ENDPOINT,
    region: S3_TEST_REGION ?? "auto",
  };
  const parent = `/${S3_TEST_BUCKET}/`;
  backendSuite("s3 service", s3, { params, env, parent, emptyFolders: false });
  backendSuite("s3 service with folder markers", s3, {
    params: { ...params, directory_markers: "true" },
    env,
    parent,
  });
}
