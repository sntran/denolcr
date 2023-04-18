import { join } from "../../deps.ts";
import { assert, assertEquals, assertHeader } from "../../dev_deps.ts";

import { fetch } from "./main.ts";

const encoder = new TextEncoder();

const tree: Record<string, string[]> = {
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
 * @param root The node to retrieve the descendants from.
 * @returns flat array of descendants with full path from `root`.
 */
function descendants(root = "/"): string[] {
  const results: string[] = [];
  const children: string[] = tree[root] || [];
  children.forEach((child) => {
    const path: string = join(root, child);
    const grandChildren: string[] = descendants(path);
    if (!grandChildren.length) {
      grandChildren.push(path);
    }
    results.push(...grandChildren);
  });

  return results;
}

Deno.test("PUT", async (t) => {
  await t.step("a new file or folder", async () => {
    for await (const fixture of descendants("/")) {
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

Deno.test("HEAD", async (t) => {
  await t.step("/", async () => {
    const pathname = "/"; // Root has both folders and files.
    const url = new URL(pathname, "memory:/");
    const request = new Request(url, {
      method: "HEAD",
    });
    const { headers, body } = await fetch(request);

    assert(!body, "should not have body");

    const links = headers.get("Link")?.split(/,\s*/);
    assert(Array.isArray(links), "should have Link headers");

    for await (const child of tree[pathname]) {
      assert(
        links.includes(`<${encodeURIComponent(child)}>`),
        `should have ${child} enclosed between < and > and percent encoded`,
      );
    }
  });

  await t.step("/folder/", async () => {
    const pathname = "/A/"; // Folder with only files
    const url = new URL(pathname, "memory:/");
    const request = new Request(url, {
      method: "HEAD",
    });
    const { headers, body } = await fetch(request);

    assert(!body, "should not have body");

    const links = headers.get("Link")?.split(/,\s*/);
    assert(Array.isArray(links), "should have Link headers");

    for await (const child of tree[pathname]) {
      assert(
        links.includes(`<${encodeURIComponent(child)}>`),
        `should have ${child} enclosed between < and > and percent encoded`,
      );
    }
  });
});

Deno.test("GET", async (t) => {
  await t.step("file", async () => {
    const pathname = "/A/"; // Folder with only files
    for await (const fixture of descendants(pathname)) {
      const url = new URL(fixture, "memory:/");
      const response = await fetch(new Request(url));
      const responseText = await response.text();
      assertEquals(responseText, fixture, "should have the same content");
    }
  });
});

Deno.test("DELETE", async (t) => {
  await t.step("file", async () => {
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

  await t.step("folder", async () => {
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
