import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { listremotes } from "./main.js";

test("listremotes gives the remotes of the config file and of the variables", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "rfetch-listremotes-"));
  const saved = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    await rm(folder, { recursive: true, force: true });
  });
  await mkdir(join(folder, "rfetch"));
  await writeFile(
    join(folder, "rfetch", "rfetch.conf"),
    "[mem]\ntype = memory\n\n[enc]\ntype = crypt\ndescription = mine\n",
  );
  process.env.XDG_CONFIG_HOME = folder;
  process.env.RFETCH_CONFIG_FROMENV_TYPE = "s3";

  assert.equal(await (await listremotes({})).text(), "mem:\nenc:\nfromenv:\n");
  assert.equal(
    await (await listremotes({ long: true })).text(),
    "mem:     memory \nenc:     crypt  mine\nfromenv: s3     \n",
  );
  assert.deepEqual(
    JSON.parse(await (await listremotes({ json: true })).text()),
    [
      { name: "mem", type: "memory", source: "file", description: "" },
      { name: "enc", type: "crypt", source: "file", description: "mine" },
      { name: "fromenv", type: "s3", source: "environment", description: "" },
    ],
  );
  assert.equal(await (await listremotes("en", {})).text(), "enc:\nfromenv:\n");
});
