/**
 * The tests of the azureblob backend: the shared tests on Azurite, when
 * `azurite-blob` is in the PATH or when AZURITE is its path, and the
 * comparison with rclone on the same Azurite, when rclone is in the PATH or
 * when RCLONE is its path.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import process from "node:process";

import { backendSuite } from "@rfetch/lib/testing/suite";
import { remote } from "@rfetch/lib/testing/remote";
// Sets the global `fetch` that reads the paths of remotes.
import { lsjson } from "../../mod.js";
import azureblob, { blockId } from "./main.js";
import { EMULATOR, hasAzurite, serveAzurite } from "./testing.js";
import { sign } from "./sharedkey.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

test("blockId writes the IDs of the blocks of rclone", () => {
  assert.equal(
    blockId(0xFEDCBA9876543210n, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    "/ty6mHZUMhABAgMEBQYHCA==",
  );
});

test("sign writes the Shared Key of Azure", () => {
  // The example of "Authorize with Shared Key", with the key of Azurite.
  const headers = sign(
    {
      method: "GET",
      url: new URL(
        "http://127.0.0.1:10000/devstoreaccount1/c?restype=container&comp=list&prefix=a%20b",
      ),
      headers: new Headers({ "x-ms-version": "2026-06-06" }),
    },
    EMULATOR,
    new Date("2026-01-02T03:04:05Z"),
  );
  assert.equal(headers.get("x-ms-date"), "Fri, 02 Jan 2026 03:04:05 GMT");
  assert.match(
    headers.get("Authorization"),
    /^SharedKey devstoreaccount1:[A-Za-z0-9+/]{43}=$/,
  );
});

if (hasAzurite) {
  const server = await serveAzurite();
  after(() => server.stop());
  const params = {
    account: EMULATOR.account,
    key: EMULATOR.key,
    endpoint: server.endpoint,
  };

  const features = {
    copy: true,
    modTime: true,
    setModTime: true,
  };
  // A container has no empty folders with no markers, as rclone.
  backendSuite("azureblob", azureblob, {
    type: "azureblob",
    params,
    parent: "/rfetch/",
    emptyFolders: false,
    features,
  });
  // Blocks of 100 KiB, thus the large file of the tests has 3 blocks.
  backendSuite("azureblob in blocks", azureblob, {
    type: "azureblob",
    params: { ...params, chunk_size: "100k" },
    parent: "/rfetch/",
    emptyFolders: false,
    features,
  });
  backendSuite("azureblob with folder markers", azureblob, {
    type: "azureblob",
    params: { ...params, directory_markers: "true" },
    parent: "/rfetch/",
    features,
  });

  describe("azureblob", () => {
    test("lists the containers", async () => {
      const fs = remote(azureblob, { params });
      await fs.put("listed/", new Uint8Array(0)).then((r) => r.body?.cancel());
      const names = (await fs.list("")).map(({ Name, IsDir }) => [Name, IsDir]);
      assert.ok(names.some(([name, isDir]) => name === "listed" && isDir));
      const response = await fs.delete("listed/");
      assert.equal(response.status, 204);
    });

    test("gives 501 for the options of Azure AD", async () => {
      const fs = remote(azureblob, { params: { ...params, use_msi: "true" } });
      const response = await fs.get("");
      assert.equal(response.status, 501);
    });

    test("puts no secret in the links of a list", async () => {
      const fs = remote(azureblob, { params, root: "/secret/" });
      await fs.put("a b.txt", new TextEncoder().encode("a")).then((r) =>
        r.body?.cancel()
      );
      const html = await fs.get("").then((response) => response.text());
      assert.ok(html.includes(' href="a%20b.txt?account='));
      assert.ok(!html.includes(encodeURIComponent(EMULATOR.key)));
      assert.ok(!html.includes("key="));
      await fs.delete("").then((r) => r.body?.cancel());
    });

    describe("and rclone", {
      skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
    }, () => {
      /**
       * Runs rclone, with no spawnSync: Azurite answers in another process,
       * but the tests wait for rclone with no block.
       * @param {...string} args
       */
      const rclone = (...args) =>
        new Promise((resolve) => {
          execFile(RCLONE, args, {
            encoding: "utf8",
            env: { PATH: process.env.PATH, HOME: "/nonexistent", TZ: "UTC" },
          }, (error, stdout, stderr) =>
            resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr }));
        });
      /** The remote of rclone on Azurite. */
      const theirs = () =>
        `:azureblob,use_emulator=true,endpoint='${server.endpoint}':both/`;
      /** The same remote for rfetch. */
      const ours = () =>
        `:azureblob,use_emulator=true,endpoint='${server.endpoint}':both/`;

      test("rclone reads the files and the times of rfetch", async () => {
        const time = "1354040105.123456789";
        for (
          const [path, text] of [["a.txt", "hello"], ["d/b.txt", "world!"]]
        ) {
          const response = await fetch(`${ours()}${path}`, {
            method: "PUT",
            headers: { "X-OC-Mtime": time },
            body: text,
          });
          assert.equal(response.status, 201);
          assert.equal(response.headers.get("X-OC-Mtime"), "accepted");
        }
        const { status, stdout, stderr } = await rclone(
          "lsjson",
          "-R",
          "--files-only",
          theirs(),
        );
        assert.equal(status, 0, stderr);
        assert.deepEqual(
          JSON.parse(stdout).map(({ Path, Size, ModTime }) => [
            Path,
            Size,
            ModTime,
          ]).sort(),
          [
            ["a.txt", 5, "2012-11-27T18:15:05.123456789Z"],
            ["d/b.txt", 6, "2012-11-27T18:15:05.123456789Z"],
          ],
        );
        assert.equal(
          (await rclone("cat", `${theirs()}d/b.txt`)).stdout,
          "world!",
        );
      });

      test("rfetch and rclone encode the names in the same way", async () => {
        // The default encoding changes a dot at the end of a name and a
        // backslash: rclone reads the names of rfetch, and rfetch reads the
        // names of rclone.
        // A backslash in a location is %5C: else the URL has a "/".
        const response = await fetch(`${ours()}names/a./b%5Cc.`, {
          method: "PUT",
          body: "x",
        });
        assert.equal(response.status, 201);
        const { status, stdout, stderr } = await rclone(
          "copyto",
          "--ignore-checksum",
          `${theirs()}names/a./b\\c.`,
          `${theirs()}names/d./e\\f.`,
        );
        assert.equal(status, 0, stderr + stdout);
        const theirList = JSON.parse(
          (await rclone("lsjson", "-R", "--files-only", `${theirs()}names`))
            .stdout,
        ).map(({ Path }) => Path).sort();
        const ourList = (await (await lsjson(`${ours()}names`, {
          recursive: true,
        })).json()).filter(({ IsDir }) => !IsDir).map(({ Path }) => Path)
          .sort();
        assert.deepEqual(theirList, ["a./b\\c.", "d./e\\f."]);
        assert.deepEqual(ourList, theirList);
      });

      test("rfetch reads the files and the times of rclone", async () => {
        const { status, stderr } = await rclone(
          "touch",
          "--timestamp",
          "2020-01-02T03:04:05.5",
          `${theirs()}c/new.txt`,
        );
        assert.equal(status, 0, stderr);
        const listed = await (await lsjson(ours(), { recursive: true })).json();
        const item = listed.find((item) => item.Path === "c/new.txt");
        assert.equal(item?.ModTime, "2020-01-02T03:04:05.500000000Z");
        assert.equal(item?.Size, 0);
        // The same list as rclone.
        const theirList = JSON.parse(
          (await rclone("lsjson", "-R", theirs())).stdout,
        );
        const shape = (list) =>
          list.map(({ Path, Size, IsDir }) => [Path, Size, IsDir]).sort();
        assert.deepEqual(shape(listed), shape(theirList));
      });
    });
  });
} else {
  test("azureblob", {
    skip: "Azurite is not installed. Set AZURITE to the path of azurite-blob.",
  });
}
