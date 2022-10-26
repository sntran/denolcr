import { join } from "../../deps.ts";
import { assert } from "../../dev_deps.ts";

import { fetch } from "./main.ts";

Deno.test("local path", async (t) => {
  const requestInit = {
    method: "HEAD",
  };

  const files: string[] = [];

  const cwd = Deno.cwd();
  const __dirname = new URL('.', import.meta.url).pathname;
  const url = new URL(`/backend?remote=${cwd}`, import.meta.url);

  const request = new Request(url, requestInit);
  const { headers, body } = await fetch(request);

  assert(!body, "should not have body");

  const links = headers.get("Link")?.split(",");
  assert(Array.isArray(links), "should have Link headers");

  let index = 0;
  for await (let { name, isDirectory } of Deno.readDir(join(cwd, "backend"))) {
    if (isDirectory) {
      name += "/";
    }
    const link = links![index++];
    assert(
      link.includes(`<${encodeURIComponent(name)}>`),
      `should have ${name} enclosed between < and > and percent encoded`,
    );

    const [_, uri] = link.match(/<(.*)>/) || [];
    files.push(decodeURIComponent(uri));
  }
});
