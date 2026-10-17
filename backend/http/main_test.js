import { test } from "node:test";
import assert from "node:assert/strict";
import backend from "./main.js";

test("GET", async (t) => {
  await t.test("error without url searchParam", async () => {
    const url = new URL("/", "file:");
    const response = await backend.fetch(new Request(url));
    assert.deepEqual(response.status, 400);
  });

  await t.test("a file", async () => {
    const remote = new URL("./", import.meta.url);

    const url = new URL("/main.js", "file:");
    url.searchParams.set("url", remote.href);

    // Fetch the remote file directly
    let response = await fetch(`${remote}/main.js`);
    const expected = await response.text();

    // Then compares with result from the backend
    response = await backend.fetch(new Request(url));
    const actual = await response.text();
    assert.deepEqual(
      actual,
      expected,
      "should be the same as fetching the remote file directly",
    );
  });

  await t.test("a directory", async () => {
    // TODO: implement
  });
});
