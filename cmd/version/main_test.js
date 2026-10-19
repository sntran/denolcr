import { test } from "node:test";
import assert from "node:assert/strict";

import info from "../../package.json" with { type: "json" };
import { version } from "./main.js";

test("version gives the version of rfetch and the runtime", async () => {
  const lines = (await version().text()).split("\n");
  assert.equal(lines[0], `rfetch v${info.version}`);
  assert.match(lines[3], /^- runtime: (node|deno|bun) \d/);
});
