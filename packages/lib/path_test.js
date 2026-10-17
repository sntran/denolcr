import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { decodePath } from "./path.js";

test("decodePath", async (t) => {
  await t.test("removes the percent-encoding of each name", () => {
    assert.equal(decodePath("/"), "/");
    assert.equal(decodePath("/a%20b/c.txt"), "/a b/c.txt");
    assert.equal(decodePath("/a%20b/"), "/a b/");
    assert.equal(decodePath("/%E4%B8%96%E7%95%8C"), "/世界");
    assert.equal(decodePath("/a%3Fb%23c"), "/a?b#c");
    assert.equal(decodePath("/test%2546.txt"), "/test%46.txt");
  });

  await t.test("gives the same name for each encoding of it", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (name) => {
        fc.pre(!/[/\0]/.test(name) && name !== "." && name !== "..");
        let encoded;
        try {
          encoded = encodeURIComponent(name);
        } catch {
          fc.pre(false); // A string with a lone surrogate has no encoding.
        }
        assert.equal(decodePath(`/${encoded}`), `/${name}`);
        assert.equal(decodePath(`/${encoded}/`), `/${name}/`);
      }),
    );
  });

  await t.test("refuses a path that can go out of the root", () => {
    for (
      const pathname of [
        "/..%2Fsecret.txt",
        "/a/..%2F..%2Fsecret.txt",
        "/%2E%2E%2Fsecret.txt",
        "/..%2F",
        "/%2E%2E",
        "/.",
        "/a/%2E/b",
      ]
    ) {
      assert.equal(decodePath(pathname), null, pathname);
    }
  });

  await t.test("refuses a path with a name that is not valid", () => {
    for (
      const pathname of [
        "",
        "a",
        "//",
        "/a//b",
        "/a%2Fb",
        "/a%00b",
        "/%E0%A4%A",
      ]
    ) {
      assert.equal(decodePath(pathname), null, pathname);
    }
  });
});
