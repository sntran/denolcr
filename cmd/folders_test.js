import { test } from "node:test";
import assert from "node:assert/strict";

import * as commands from "./main.js";
import { FOLDERS } from "./folders.js";

test("FOLDERS has each command, and the folder of its module", async () => {
  assert.deepEqual(
    Object.keys(FOLDERS).toSorted(),
    Object.keys(commands).toSorted(),
  );
  for (const [name, folder] of Object.entries(FOLDERS)) {
    const module = await import(`./${folder}/main.js`);
    assert.equal(module[name], commands[name], name);
  }
});
