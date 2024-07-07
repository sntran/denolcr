import { test } from "node:test";
import { join } from "../../deps.js";
import { assert, assertEquals, assertHeader } from "../../dev_deps.js";

import backend from "./main.js";

const fetch = backend.fetch;

const encoder = new TextEncoder();

const tree = {
  "/": ["A/", "B/", "C/", "a", "b", "c"],
  "/A/": ["a", "b", "c"],
  "/B/": ["a", "c"],
  "/C/": [],
};

/**
 * Returns an array of descendants from `root` to the leaf nodes.
 *
 * Example:
 *
 * ```ts
 * descendants("/");
 * // ["/A/a", "/A/b", "/B/a", "/B/c", "/C/", "/a", "/b"]
 * ```
 *
 * @param {string} [root="/"] The node to retrieve the descendants from.
 * @returns {string[]} flat array of descendants with full path from `root`.
 */
function descendants(root = "/") {
  /**
   * @type {string[]}
   */
  const results = [];
  /**
   * @type {string[]}
   */
  const children = tree[root] || [];
  children.forEach((child) => {
    const path = join(root, child);
    const grandChildren = descendants(path);
    if (!grandChildren.length) {
      grandChildren.push(path);
    }
    results.push(...grandChildren);
  });

  return results;
}

test("PUT", async (t) => {
  await t.test("a new file or folder", async () => {
    for (const fixture of descendants("/")) {
      const url = new URL(fixture, "memory:/");
      // Sends the PUT request with the body.
      const request = new Request(url, {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": `${encoder.encode(fixture).byteLength}`,
        },
        body: fixture,
      });
      const { status, headers } = await fetch(request);

      assertEquals(status, 201, "should respond with 201 Created");
      assertHeader(headers, "Content-Location", fixture);
    }
  });
});

test("GET", async (t) => {
  await t.test("folder", async () => {
    const pathname = "/"; // Root folder
    let url = new URL(pathname, "memory:/");
    let response = await fetch(new Request(url));
    assert(response.headers.get("Content-Type")?.includes("text/html"));
    const html = await response.text();

    for (const child of tree[pathname]) {
      assert(
        html.includes(` href="${child}`),
        `should have link to ${child}`,
      );

      if (child.endsWith("/")) {
        const childPathname = pathname + child;

        url = new URL(childPathname, "memory:/");
        response = await fetch(new Request(url));
        assert(response.headers.get("Content-Type")?.includes("text/html"));
        const childHtml = await response.text();

        for (const grandchild of tree[childPathname]) {
          assert(
            childHtml.includes(` href="${grandchild}`),
            `should have link to ${grandchild}`,
          );
        }
      }
    }
  });

  await t.test("file", async () => {
    const pathname = "/A/"; // Folder with only files
    for (const fixture of descendants(pathname)) {
      const url = new URL(fixture, "memory:/");
      const response = await fetch(new Request(url));
      const responseText = await response.text();
      assertEquals(responseText, fixture, "should have the same content");
    }
  });
});

test("DELETE", async (t) => {
  await t.test("file", async () => {
    const pathname = "/B/"; // Folder with only files
    for await (const fixture of descendants(pathname)) {
      const url = new URL(`${pathname}${fixture}`, "memory:/");
      let response = await fetch(
        new Request(url, {
          method: "DELETE",
        }),
      );
      assertEquals(response.status, 204, "should respond with 204 No Content");

      response = await fetch(new Request(url));
      assertEquals(response.status, 404, "should respond with 404 Not Found");
    }
  });

  await t.test("folder", async () => {
    const pathname = "/A/"; // Folder with many files
    const url = new URL(pathname, "memory:/");
    const response = await fetch(
      new Request(url, {
        method: "DELETE",
      }),
    );
    assertEquals(response.status, 204, "should respond with 204 No Content");

    for await (const fixture of descendants(pathname)) {
      const url = new URL(fixture, "memory:/");
      const response = await fetch(new Request(url));
      assertEquals(response.status, 404, "should respond with 404 Not Found");
    }
  });
});
