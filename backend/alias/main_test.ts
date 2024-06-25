import { join } from "../../deps.ts";
import { assert } from "../../dev_deps.ts";

import backend from "./main.ts";

Deno.test("local path", async () => {
  const requestInit = {
    method: "GET",
  };

  const cwd = Deno.cwd();
  const url = new URL(`/backend/?remote=.`, import.meta.url);

  const request = new Request(url, requestInit);
  const response = await backend.fetch(request);
  const html = await response.text();

  for await (let { name, isDirectory } of Deno.readDir(join(cwd, "backend"))) {
    if (isDirectory) {
      name += "/";
    }
    assert(
      html.includes(` href="${name}`),
      `should have link to ${name}`,
    );
  }
});
