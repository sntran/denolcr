import { contentType, extname, join } from "../../deps.ts";
import { assert, assertEquals, assertHeader } from "../../dev_deps.ts";

import { fetch } from "./main.ts";

const USER = Deno.env.get("RCLONE_FSHARE_USER") || "";
const PASS = Deno.env.get("RCLONE_FSHARE_PASS") || "";

Deno.test("Authorization", async (t) => {
  await t.step(
    "should fail with 401 Unauthorized when credentials not provided",
    async () => {
      const url = new URL("/", "file:");
      const { status } = await fetch(new Request(url));
      assertEquals(status, 401);
    },
  );
});

Deno.test("HEAD", async (t) => {
  const requestInit = {
    method: "HEAD",
    headers: {
      Authorization: `Basic ${btoa(`${USER}:${PASS}`)}`,
    },
  };

  let files: string[];

  await t.step("/", async () => {
    const url = new URL("/", "file:");
    const request = new Request(url, requestInit);
    const { headers, body } = await fetch(request);

    assert(!body, "should not have body");

    files = headers.get("Link")?.split(",").map((link) => {
      const [_, uri] = link.match(/<(.*)>/) || [];
      return decodeURIComponent(uri);
    })!;
    assert(Array.isArray(files), "should have Link headers");
  });

  await t.step("/file.ext", async () => {
    for await (const name of files) {
      // Checking links only
      if (name.endsWith("/")) continue;

      const url = new URL(join("/", name), "file:");
      const request = new Request(url, requestInit);
      const { headers, body } = await fetch(request);

      assert(!body, "should not have body");
      assert(!headers.get("Link"), "should not have Link headers");

      assertHeader(headers, "Content-Type");
      assertHeader(headers, "Content-Length");
      assertHeader(headers, "Last-Modified");
      assertHeader(headers, "ETag");
    }
  });

  await t.step("/subfolder/", async () => {
    for await (const name of files) {
      // Checking subfolders only.
      if (!name.endsWith("/")) continue;

      const url = new URL(join("/", name), "file:");
      const request = new Request(url, requestInit);
      const { headers, body } = await fetch(request);

      assert(!body, "should not have body");

      files = (headers.get("Link") || "").split(",").filter((l) => l).map(
        (link) => {
          const [_, uri] = link.match(/<(.*)>/) || [];
          return decodeURIComponent(uri);
        },
      )!;
      assert(Array.isArray(files), "should have Link headers");
    }
  });
});

Deno.test("GET", async (t) => {
  const requestInit = {
    method: "GET",
    headers: {
      Authorization: `Basic ${btoa(`${USER}:${PASS}`)}`,
    },
  };

  let files: string[] = [];

  // `GET /folder` is same as `HEAD /folder`.
  await t.step("/", async () => {
    const url = new URL("/", "file:");
    const request = new Request(url, requestInit);
    const { headers, body } = await fetch(request);

    assert(!body, "should not have body");

    files = headers.get("Link")?.split(",").map((link) => {
      const [_, uri] = link.match(/<(.*)>/) || [];
      return decodeURIComponent(uri);
    })!;
    assert(Array.isArray(files), "should have Link headers");
  });

  await t.step("a file ./main.ts", async () => {
    for await (const name of files) {
      // Checking links for now
      if (name.endsWith("/")) continue;

      const url = new URL(`/${name}`, "file:");
      const request = new Request(url, requestInit);
      const response = await fetch(request);
      const { headers, body } = response;

      assertHeader(headers, "Content-Type", contentType(extname(name)) || "");
      assertHeader(headers, "Content-Length");
      assertHeader(headers, "Last-Modified");

      assert(
        body instanceof ReadableStream,
        "should have body as a ReadableStream",
      );
    }
  });
});
