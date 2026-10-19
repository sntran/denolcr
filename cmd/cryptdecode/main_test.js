import { test } from "node:test";
import assert from "node:assert/strict";

import { obscure } from "@rfetch/lib/obscure";
import { fetch } from "../../fetch.js";
import { contents, putFiles } from "../testing.js";
import { cryptdecode } from "./main.js";

test("cryptdecode decrypts and encrypts the names of a crypt remote", async () => {
  const password = await (await obscure("cryptdecode")).text();
  const remote = `:crypt,remote=':memory:/cryptdecode',password='${password}':`;
  await putFiles(remote, { "a/g.txt": "world!" });
  const [encrypted] = Object.keys(
    (await contents(":memory:/cryptdecode/")).files,
  );
  const [folder, file] = encrypted.split("/");

  assert.equal(
    await (await cryptdecode(remote, folder, encrypted, "bad-name", {})).text(),
    `${folder} \t a\n${encrypted} \t a/g.txt\nbad-name \t Failed to decrypt\n`,
  );
  assert.equal(
    await (await cryptdecode(remote, "a/g.txt", { reverse: true })).text(),
    `a/g.txt \t ${folder}/${file}\n`,
  );
  // The options can come in the flags of the command too.
  const flagged = await cryptdecode(":crypt:", folder, {
    crypt_remote: ":memory:/cryptdecode",
    crypt_password: password,
  });
  assert.equal(await flagged.text(), `${folder} \t a\n`);

  const plain = await cryptdecode(":memory:", "x", {});
  assert.equal(plain.status, 400);
  await (await fetch(":memory:/cryptdecode/", { method: "DELETE" })).body
    ?.cancel();
});
