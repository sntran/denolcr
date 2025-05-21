import { test } from "node:test";
import process from "node:process";
import { readdir } from "node:fs/promises";
import { join } from "../../deps.js";
import { assert } from "../../dev_deps.js";

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
