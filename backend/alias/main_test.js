import { test } from "node:test";
import process from "node:process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

import { backendSuite } from "../../lib/testing/suite.js";
import { remote } from "../../lib/testing/remote.js";
import backend from "./main.js";

test("local path", async () => {
  const requestInit = {
    method: "GET",
  };

  const cwd = process.cwd();
  const url = new URL(`/backend/?remote=.`, import.meta.url);

  const request = new Request(url, requestInit);
  const response = await backend.fetch(request);
  const html = await response.text();

  const entries = await readdir(join(cwd, "backend"), { withFileTypes: true });
  for await (const entry of entries) {
    let name = entry.name;
    if (entry.isDirectory()) {
      name += "/";
    }
    assert(
      html.includes(` href="${name}`),
      `should have link to ${name}`,
    );
  }
});

backendSuite("alias", backend, { params: { remote: ":memory:/alias" } });

test("the links of a list are in the alias", async () => {
  const fs = remote(backend, { params: { remote: ":memory:/links" } });
  await fs.put("a b.txt", new TextEncoder().encode("a"));
  const html = await fs.get("").then((response) => response.text());
  assert.ok(html.includes(` href="a%20b.txt?remote=%3Amemory%3A%2Flinks"`));
  assert.ok(html.includes(` href="../?remote=%3Amemory%3A%2Flinks"`));
});
