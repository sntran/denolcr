import { assertEquals } from "../../dev_deps.ts";
import backend from "./main.ts";

Deno.test("GET", async (t) => {
  await t.step("error without url searchParam", async () => {
    const url = new URL("/", "file:");
    const response = await backend.fetch(new Request(url));
    assertEquals(response.status, 400);
  });

  await t.step("a file", async () => {
    const remote = new URL("./", import.meta.url);

    const url = new URL("/main.ts", "file:");
    url.searchParams.set("url", remote.href);

    let response = await fetch(`${remote}/main.ts`);
    const expected = await response.text();

    response = await backend.fetch(new Request(url));
    const actual = await response.text();
    assertEquals(
      actual,
      expected,
      "should be the same as fetching the remote file directly",
    );
  });

  await t.step("a directory", async () => {
    // TODO: implement
  });
});
