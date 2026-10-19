/**
 * The tests of the sftp backend, on `rclone serve sftp`: the shared tests,
 * the host keys, the keys of the user, and the comparison with the sftp
 * backend of rclone on the same server. They run when rclone is in the PATH,
 * or when RCLONE is the path of rclone. The keys come from openssl.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { obscure } from "@rfetch/lib/obscure";
import { backendSuite } from "@rfetch/lib/testing/suite";
import { remote } from "@rfetch/lib/testing/remote";
// Sets the global `fetch` that reads the paths of remotes.
import { lsjson } from "../../mod.js";
import sftp from "./main.js";
import { readPrivateKey, toBase64 } from "./ssh/keys.js";
import {
  hasOpenSSL,
  hasRclone,
  KEY_PARAMS,
  LOGIN,
  makeKey,
  makeKeys,
  serveSFTP,
} from "./testing.js";

const RCLONE = process.env.RCLONE || "rclone";

/** The password of the test server, obscured as in the config of rclone. */
const pass = await (await obscure(LOGIN.pass)).text();

/**
 * The line of a public key, as in `authorized_keys` and in `host_keys`.
 * @param {string} pem
 */
async function keyLine(pem) {
  const key = await readPrivateKey(pem);
  return `${key.type} ${toBase64(key.blob)}`;
}

if (hasRclone && hasOpenSSL) {
  const hostKey = makeKey("ed25519");
  const userKeys = {
    ed25519: makeKey("ed25519"),
    ecdsa: makeKey("ecdsa", "traditional"),
    rsa: makeKey("rsa", "traditional"),
    "rsa pkcs8": makeKey("rsa"),
  };
  // Keys of WebCrypto, also in the format of OpenSSH.
  const openSSHKeys = await Promise.all(
    Object.values(KEY_PARAMS).map((params) => makeKeys(params)),
  );
  const server = await serveSFTP({
    hostKeys: [hostKey, makeKey("ecdsa"), makeKey("rsa")],
    authorizedKeys: [
      ...await Promise.all(Object.values(userKeys).map(keyLine)),
      ...await Promise.all(openSSHKeys.map(({ pem }) => keyLine(pem))),
    ],
  });
  after(() => server.stop());
  const hostKeys = await keyLine(hostKey);
  const params = {
    host: server.host,
    port: `${server.port}`,
    user: LOGIN.user,
    pass,
    host_keys: hostKeys,
  };

  backendSuite("sftp", sftp, {
    type: "sftp",
    params,
    features: {
      move: true,
      dirMove: true,
      modTime: true,
      setModTime: true,
    },
  });
  // One read and one write at a time, of 1000 bytes.
  backendSuite("sftp with small chunks", sftp, {
    params: { ...params, chunk_size: "1000b", concurrency: "1" },
    features: { move: true, dirMove: true, modTime: true, setModTime: true },
  });
  backendSuite("sftp with a key", sftp, {
    params: {
      host: server.host,
      port: `${server.port}`,
      user: LOGIN.user,
      key_pem: userKeys.ed25519.replaceAll("\n", "\\n"),
      host_keys: hostKeys,
    },
    features: { move: true, dirMove: true, modTime: true, setModTime: true },
  });

  describe("sftp", () => {
    const fs = remote(sftp, { params, root: "/sftp-test/" });

    test("signs in with each type of key", async () => {
      for (const [name, pem] of Object.entries(userKeys)) {
        const response = await remote(sftp, {
          params: {
            host: server.host,
            port: `${server.port}`,
            user: LOGIN.user,
            key_pem: pem,
            host_keys: hostKeys,
          },
        }).get("");
        await response.body?.cancel();
        assert.equal(response.status, 200, name);
      }
    });

    test("uses each host key and each cipher", async () => {
      for (
        const options of [
          { host_key_algorithms: "ecdsa-sha2-nistp256" },
          { host_key_algorithms: "rsa-sha2-512" },
          { host_key_algorithms: "rsa-sha2-256" },
          { ciphers: "aes256-gcm@openssh.com" },
          { ciphers: "aes128-ctr", macs: "hmac-sha2-256-etm@openssh.com" },
          { ciphers: "aes256-ctr", macs: "hmac-sha2-512" },
          { key_exchange: "ecdh-sha2-nistp256" },
          { key_exchange: "ecdh-sha2-nistp384" },
          { key_exchange: "ecdh-sha2-nistp521" },
        ]
      ) {
        const data = new Uint8Array(100000).map((_, i) => i * 13);
        const other = remote(sftp, {
          params: { ...params, host_keys: "", ...options },
          root: "/sftp-test/",
        });
        const put = await other.put("cipher.bin", data);
        assert.equal(put.status, 201, JSON.stringify(options));
        const response = await other.get("cipher.bin");
        assert.deepEqual(
          new Uint8Array(await response.arrayBuffer()),
          data,
          JSON.stringify(options),
        );
      }
    });

    test("refuses a host key that is not in host_keys", async () => {
      const response = await remote(sftp, {
        params: { ...params, host_keys: await keyLine(makeKey("ed25519")) },
      }).get("");
      const text = await response.text();
      assert.equal(response.status, 502);
      assert.match(
        text,
        /The host key SHA256:\S+ of the server is not in host_keys/,
      );
    });

    test("checks the host key with known_hosts_file", async () => {
      const file = join(server.folder, "..", "known_hosts");
      const line = await keyLine(hostKey);
      for (
        const [hosts, status] of [
          [`[${server.host}]:${server.port}`, 200],
          [`[127.0.0.*]:${server.port}`, 200],
          [`[${server.host}]:1`, 502],
          [server.host, 502],
        ]
      ) {
        writeFileSync(file, `# A comment\n${hosts} ${line}\n`);
        const response = await remote(sftp, {
          params: { ...params, host_keys: "", known_hosts_file: file },
        }).get("");
        await response.body?.cancel();
        assert.equal(response.status, status, hosts);
      }
      // A hashed name, as `ssh-keygen -H` writes it.
      const salt = crypto.getRandomValues(new Uint8Array(20));
      const key = await crypto.subtle.importKey(
        "raw",
        salt,
        { name: "HMAC", hash: "SHA-1" },
        false,
        ["sign"],
      );
      const hash = new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`[${server.host}]:${server.port}`),
        ),
      );
      writeFileSync(file, `|1|${toBase64(salt)}|${toBase64(hash)} ${line}\n`);
      let response = await remote(sftp, {
        params: { ...params, host_keys: "", known_hosts_file: file },
      }).get("");
      await response.body?.cancel();
      assert.equal(response.status, 200, "hashed name");
      // A revoked key.
      writeFileSync(
        file,
        `@revoked * ${line}\n[${server.host}]:${server.port} ${line}\n`,
      );
      response = await remote(sftp, {
        params: { ...params, host_keys: "", known_hosts_file: file },
      }).get("");
      await response.body?.cancel();
      assert.equal(response.status, 502, "revoked key");
    });

    test("gives 403 for a wrong password", async () => {
      const wrong = await (await obscure("wrong")).text();
      const response = await remote(sftp, {
        params: { ...params, pass: wrong },
      })
        .get("");
      await response.body?.cancel();
      assert.equal(response.status, 403);
    });

    test("puts no secret in the links of a list", async () => {
      await fs.put("a b.txt", new TextEncoder().encode("a")).then((r) =>
        r.body?.cancel()
      );
      const html = await fs.get("").then((response) => response.text());
      assert.ok(html.includes(' href="a%20b.txt?host='));
      assert.ok(!html.includes("pass="), "the password is in a link");
      assert.ok(!html.includes("user="), "the user is in a link");
    });

    test("gives 400 and 501 for options that are not correct", async () => {
      for (
        const [options, status] of [
          [{ host: "" }, 400],
          [{ port: "70000" }, 400],
          [{ pass: "", key_pem: "" }, 400],
          [{ chunk_size: "1M" }, 400],
          [{ key_use_agent: "true" }, 501],
          [{ ciphers: "chacha20-poly1305@openssh.com" }, 501],
          [{
            key_pem:
              "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
          }, 400],
        ]
      ) {
        const response = await remote(sftp, {
          params: { ...params, ...options },
        })
          .get("");
        await response.body?.cancel();
        assert.equal(response.status, status, JSON.stringify(options));
      }
    });

    test("reads a path from the root of the server", async () => {
      // The login folder of rclone serve sftp is the root of the server.
      await fs.put("root.txt", new TextEncoder().encode("root"));
      const response = await fetch(
        `:sftp,host=${server.host},port=${server.port},user=${LOGIN.user},pass=${pass},host_keys='${hostKeys}':/sftp-test/root.txt`,
      );
      assert.equal(await response.text(), "root");
    });

    test("deletes the files of the tests", async () => {
      const response = await fs.delete("");
      assert.equal(response.status, 204);
    });

    describe("and rclone", () => {
      /**
       * Runs rclone, with no spawnSync: the server is another process, but
       * the tests wait for rclone with no block.
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
      /** The same remote for rclone and for rfetch. */
      const location = (path = "") =>
        `:sftp,host=${server.host},port=${server.port},user=${LOGIN.user},pass=${pass},host_keys='${hostKeys}':both/${path}`;

      test("rfetch and rclone sign in with the same OpenSSH keys", async () => {
        // rclone reads the key with Go: the key of the test has the format
        // of OpenSSH.
        const names = Object.keys(KEY_PARAMS);
        for (const [index, { openssh }] of openSSHKeys.entries()) {
          const file = join(server.folder, "..", `id_${index}`);
          writeFileSync(file, openssh, { mode: 0o600 });
          const remoteOf = (option) =>
            `:sftp,host=${server.host},port=${server.port},user=${LOGIN.user},${option},host_keys='${hostKeys}':`;
          const theirs = await rclone(
            "lsjson",
            remoteOf(`key_file='${file}'`),
          );
          assert.equal(theirs.status, 0, `${names[index]}: ${theirs.stderr}`);
          const ours = await fetch(remoteOf(`key_file='${file}'`));
          await ours.body?.cancel();
          assert.equal(ours.status, 200, names[index]);
        }
      });

      test("rclone reads the files and the times of rfetch", async () => {
        for (
          const [path, text] of [["a.txt", "hello"], ["d/b c.txt", "world!"]]
        ) {
          const response = await fetch(location(path.replace(" ", "%20")), {
            method: "PUT",
            headers: { "X-OC-Mtime": "1354040105.5" },
            body: text,
          });
          assert.equal(response.status, 201);
          assert.equal(response.headers.get("X-OC-Mtime"), "accepted");
        }
        const { status, stdout, stderr } = await rclone(
          "lsjson",
          "-R",
          "--files-only",
          location(),
        );
        assert.equal(status, 0, stderr);
        assert.deepEqual(
          JSON.parse(stdout).map(({ Path, Size, ModTime }) => [
            Path,
            Size,
            ModTime,
          ]).sort(),
          [
            ["a.txt", 5, "2012-11-27T18:15:05Z"],
            ["d/b c.txt", 6, "2012-11-27T18:15:05Z"],
          ],
        );
        assert.equal(
          (await rclone("cat", location("d/b c.txt"))).stdout,
          "world!",
        );
      });

      test("rfetch reads the files and the times of rclone", async () => {
        const { status, stderr } = await rclone(
          "touch",
          "--timestamp",
          "2020-01-02T03:04:05",
          location("c/new.txt"),
        );
        assert.equal(status, 0, stderr);
        const listed = await (await lsjson(location(), { recursive: true }))
          .json();
        const item = listed.find((item) => item.Path === "c/new.txt");
        assert.equal(
          Date.parse(item?.ModTime),
          Date.parse("2020-01-02T03:04:05Z"),
        );
        assert.equal(item?.Size, 0);
        const theirList = JSON.parse(
          (await rclone("lsjson", "-R", location())).stdout,
        );
        const shape = (list) =>
          list.map(({ Path, Size, IsDir }) => [Path, Size, IsDir]).sort();
        assert.deepEqual(shape(listed), shape(theirList));
      });

      test("rfetch and rclone encode the names in the same way", async () => {
        // The default encoding changes a control character.
        const response = await fetch(location("names/a%0Bb.txt"), {
          method: "PUT",
          body: "x",
        });
        assert.equal(response.status, 201);
        // rclone shows a control character as its picture.
        const theirs = JSON.parse(
          (await rclone("lsjson", location("names"))).stdout,
        );
        assert.deepEqual(theirs.map(({ Name }) => Name), ["a␋b.txt"]);
        const ours = await (await lsjson(location("names"))).json();
        assert.deepEqual(ours.map(({ Name }) => Name), ["a\u000bb.txt"]);
        await fetch(location(""), { method: "DELETE" }).then((r) =>
          r.body?.cancel()
        );
      });
    });
  });
} else {
  test("sftp", {
    skip:
      "rclone or openssl is not installed. Set RCLONE to the path of rclone.",
  });
}
