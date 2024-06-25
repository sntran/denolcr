import { contentType, extname, join } from "../../deps.ts";
import {
  assert,
  assertEquals,
  assertHeader,
  assertRejects,
} from "../../dev_deps.ts";

import backend from "./main.ts";

const fetch = backend.fetch;

const encoder = new TextEncoder();
const cwd = Deno.cwd();

Deno.test("GET", async (t) => {
  const requestInit = {
    method: "GET",
  };

  const files: string[] = [];

  await t.step("/", async () => {
    const url = new URL("/", "local://");
    const request = new Request(url, requestInit);
    const response = await fetch(request);
    const { headers, body } = response;

    assert(body, "should have body");
    assert(headers.get("Content-Type")!.includes("text/html"));
    const html = await response.text();

    for await (let { name, isDirectory } of Deno.readDir(cwd)) {
      if (isDirectory) {
        name += "/";
      }

      assert(
        html.includes(` href="${name}`),
        "should have the link in the HTML",
      );

      files.push(name);
    }
  });

  await t.step("a file ./main.ts", async () => {
    for await (const name of files) {
      // Checking links for now
      if (name.endsWith("/")) continue;

      const path = join(cwd, name);
      const file = await Deno.stat(path);

      const url = new URL(`/${name}`, "local://");
      const request = new Request(url, requestInit);
      const response = await fetch(request);
      const { headers, body } = response;

      assertHeader(headers, "Content-Type", contentType(extname(name)) || "");
      assertHeader(headers, "Content-Length", `${file.size}`);
      assertHeader(headers, "Last-Modified", file.mtime?.toUTCString() || "");

      assert(
        body instanceof ReadableStream,
        "should have body as a ReadableStream",
      );
      assertEquals(
        await response.text(),
        await Deno.readTextFile(path),
        "should have the same content",
      );
    }
  });
});

const newFile = "dummy.file";
const newFolder = "dummy.folder/"; // Must have trailing slash.

Deno.test("PUT", async (t) => {
  await t.step("a new file", async () => {
    const targetFile = join(cwd, newFile);
    const body = "Hello World";

    const url = new URL(`/${newFile}`, "local://");
    // Sends the PUT request with the body.
    const request = new Request(url, {
      method: "PUT",
      headers: {
        "Content-Type": contentType(extname(newFile)) ||
          "application/octet-stream",
        "Content-Length": `${encoder.encode(body).byteLength}`,
      },
      body,
    });
    const { status, headers } = await fetch(request);

    assertEquals(status, 201, "should respond with 201 Created");
    assertHeader(headers, "Content-Location", `/${newFile}`);

    assertEquals(
      await Deno.readTextFile(targetFile),
      body,
      "should have the same content",
    );

    // Also checks the content with a GET request.
    const response = await fetch(new Request(url));
    assertEquals(await response.text(), body, "should have the same content");
  });

  await t.step("a new folder", async () => {
    const targetFolder = join(cwd, newFolder);

    const url = new URL(`/${newFolder}`, "local://");
    // Sends the PUT request with no body.
    const request = new Request(url, {
      method: "PUT",
      headers: {
        "Content-Type": "text/directory",
        "Content-Length": "0",
      },
    });
    const { status, headers } = await fetch(request);

    assertEquals(status, 201, "should respond with 201 Created");
    assertHeader(headers, "Content-Location", `/${newFolder}`);

    const stat = await Deno.stat(targetFolder);
    assert(stat.isDirectory, "should be a directory");
  });

  await t.step("a new nested file", async () => {
    const targetFile = join(cwd, newFolder, newFile);
    const body = "Hello Nested World";

    const url = new URL(`/${join(newFolder, newFile)}`, "local://");
    // Sends the PUT request with the body.
    const request = new Request(url, {
      method: "PUT",
      headers: {
        "Content-Type": contentType(extname(newFile)) ||
          "application/octet-stream",
        "Content-Length": `${encoder.encode(body).byteLength}`,
      },
      body,
    });
    const { status, headers } = await fetch(request);

    assertEquals(status, 201, "should respond with 201 Created");
    assertHeader(headers, "Content-Location", `/${join(newFolder, newFile)}`);

    assertEquals(
      await Deno.readTextFile(targetFile),
      body,
      "should have the same content",
    );

    // Also checks the content with a GET request.
    const response = await fetch(new Request(url));
    assertEquals(await response.text(), body, "should have the same content");
  });
});

Deno.test("DELETE", async (t) => {
  await t.step("a file", async () => {
    const targetFile = join(cwd, newFile);
    const url = new URL(`/${newFile}`, "local://");
    // Sends the PUT request with the body.
    const request = new Request(url, {
      method: "DELETE",
    });
    const { status } = await fetch(request);
    assertEquals(status, 204, "should respond with 204 No Content");

    assertRejects(() => {
      return Deno.stat(targetFile);
    });
  });

  await t.step("a folder", async () => {
    const targetFolder = join(cwd, newFolder);
    const url = new URL(`/${newFolder}`, "local://");
    // Sends the PUT request with the body.
    const request = new Request(url, {
      method: "DELETE",
    });
    const { status } = await fetch(request);
    assertEquals(status, 204, "should respond with 204 No Content");

    assertRejects(() => {
      return Deno.stat(targetFolder);
    });
  });
});
