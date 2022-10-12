import { contentType, digest, extname, join } from "../../deps.ts";
import { assert, assertEquals, assertRejects } from "../../dev_deps.ts";

import { fetch } from "./main.ts";

const encoder = new TextEncoder();
const cwd = Deno.cwd();

function assertHeader(headers: Headers, name: string, value: string) {
  assertEquals(
    headers.get(name),
    value,
    `should have ${name} header of ${value} instead of ${headers.get(name)}`,
  );
}

Deno.test("HEAD", async (t) => {
  const requestInit = {
    method: "HEAD",
  };

  await t.step("base ./", async () => {
    const url = new URL(join(cwd, "./"), import.meta.url);
    const request = new Request(url, requestInit);
    const { headers, body } = await fetch(request);

    assert(!body, "should not have body");

    const links = headers.get("Link")?.split(",");
    assert(Array.isArray(links), "should have Link headers");

    let index = 0;
    for await (const { name } of Deno.readDir(url)) {
      const link = links![index++];
      assert(
        link.includes(`<${name}>`),
        `should have ${name} enclosed between < and > and percent encoded`,
      );
    }
  });

  await t.step("a file ./main.ts", async () => {
    for await (const { name, isFile } of Deno.readDir(cwd)) {
      if (!isFile) continue;
      const path = join(cwd, name);
      const file = await Deno.stat(path);

      const url = new URL(path, import.meta.url);
      const request = new Request(url, requestInit);
      const { headers, body } = await fetch(request);

      assert(!body, "should not have body");
      assert(!headers.get("Link"), "should not have Link headers");

      assertHeader(headers, "Content-Type", contentType(extname(name)) || "");
      assertHeader(headers, "Content-Length", `${file.size}`);
      assertHeader(headers, "Last-Modified", file.mtime?.toUTCString() || "");

      // For local files, the ETag is the MD5 hash of the file.
      assertHeader(headers, "ETag", `"${await digest(path)}"`);
    }
  });
});

Deno.test("GET", async (t) => {
  const requestInit = {
    method: "GET",
  };

  // `GET /folder` is same as `HEAD /folder`.
  await t.step("base ./", async () => {
    const url = new URL(join(cwd, "./"), import.meta.url);
    const request = new Request(url, requestInit);
    const { headers, body } = await fetch(request);

    assert(!body, "should not have body");

    const links = headers.get("Link")?.split(",");
    assert(Array.isArray(links), "should have Link headers");

    let index = 0;
    for await (const { name } of Deno.readDir(url)) {
      const link = links![index++];
      assert(
        link.includes(`<${name}>`),
        `should have ${name} enclosed between < and > and percent encoded`,
      );
    }
  });

  await t.step("a file ./main.ts", async () => {
    for await (const { name, isFile } of Deno.readDir(cwd)) {
      if (!isFile) continue;
      const path = join(cwd, name);
      const file = await Deno.stat(path);

      const url = new URL(path, import.meta.url);
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

    const url = new URL(targetFile, import.meta.url);
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
    assertHeader(headers, "Content-Location", targetFile);

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

    const url = new URL(targetFolder, import.meta.url);
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
    assertHeader(headers, "Content-Location", targetFolder);

    const stat = await Deno.stat(targetFolder);
    assert(stat.isDirectory, "should be a directory");
  });

  await t.step("a new nested file", async () => {
    const targetFile = join(cwd, newFolder, newFile);
    const body = "Hello Nested World";

    const url = new URL(targetFile, import.meta.url);
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
    assertHeader(headers, "Content-Location", targetFile);

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
    const url = new URL(targetFile, import.meta.url);
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
    const url = new URL(targetFolder, import.meta.url);
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
