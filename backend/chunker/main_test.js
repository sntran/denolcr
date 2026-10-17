import { test } from "node:test";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import memory from "../memory/main.js";
import backend from "./main.js";

/**
 * Tells if the two arrays have the same bytes.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
const sameBytes = (a, b) => Buffer.compare(a, b) === 0;

const buffer = new Uint8Array(randomBytes(1024 * 1024 * 10)); // 10M
const file = new File([buffer], "10M.bin", {
  type: "application/octet-stream",
});
const MD5 = createHash("md5").update(buffer).digest("hex");

let chunkSize = 1024 * 1024 * 4; // 4M

const url = new URL(`/${file.name}`, "file:");
url.searchParams.set("remote", ":memory:");
url.searchParams.set("chunk_size", `${chunkSize}`);

function cleanup(pathname = "/") {
  return memory.fetch(
    new Request(new URL(pathname, "memory:/"), {
      method: "DELETE",
    }),
  );
}

test("PUT", async (t) => {
  await t.test("new file", async () => {
    let request = new Request(url, {
      method: "PUT",
      body: file,
    });

    let response = await backend.fetch(request);
    await response.arrayBuffer(); // To kickstart the request.

    // Checks the underlying remote to have the chunks.
    request = new Request(new URL("/", "memory:/"), {
      method: "HEAD",
    });
    response = await memory.fetch(request);
    const links = response.headers.get("Link")?.split(/,\s*/);
    const chunks = Math.ceil(file.size / chunkSize);

    let startFrom = 1;
    for (; startFrom < chunks; startFrom++) {
      const link = links[startFrom - 1];
      const chunkName = `${
        encodeURIComponent(file.name)
      }.rclone_chunk.00${startFrom}`;
      assert.deepEqual(link, `<${chunkName}>`, `should have ${chunkName}`);

      request = new Request(new URL(`/${chunkName}`, "memory:/"));
      response = await memory.fetch(request);
      const chunk = await response.arrayBuffer();

      if (startFrom < chunks) {
        assert.deepEqual(chunk.byteLength, chunkSize);
      } else {
        assert.deepEqual(chunk.byteLength, file.size % chunkSize);
      }
    }
  });

  await cleanup();

  await t.test("chunk_size, name_format, start_from", async () => {
    chunkSize = 100 * 1024; // 100K, so we can have hundreds of chunks
    let startFrom = 0;

    url.searchParams.set("chunk_size", `${chunkSize}`);
    url.searchParams.set("name_format", `${file.name}.part##`);
    url.searchParams.set("start_from", `${startFrom}`);

    let request = new Request(url, {
      method: "PUT",
      body: file,
    });

    let response = await backend.fetch(request);
    await response.arrayBuffer(); // To kickstart the request.

    // Checks the underlying remote to have the chunks.
    request = new Request(new URL("/", "memory:/"), {
      method: "HEAD",
    });
    response = await memory.fetch(request);
    const links = response.headers.get("Link")?.split(/,\s*/);
    const chunks = Math.ceil(file.size / chunkSize);

    for (; startFrom < chunks; startFrom++) {
      const link = links[startFrom];

      let chunkName = "";
      if (startFrom < 10) {
        chunkName = `${encodeURIComponent(file.name)}.part0${startFrom}`;
      } else if (startFrom < 100) {
        chunkName = `${encodeURIComponent(file.name)}.part${startFrom}`;
      } else {
        chunkName = `${encodeURIComponent(file.name)}.part${startFrom}`;
      }
      assert.deepEqual(
        link,
        `<${chunkName}>`,
        `chunk ${startFrom} should have name of ${chunkName}, not ${link}`,
      );

      request = new Request(new URL(`/${chunkName}`, "memory:/"));
      response = await memory.fetch(request);
      const chunk = await response.arrayBuffer();

      if (startFrom < chunks - 1) {
        assert.deepEqual(chunk.byteLength, chunkSize);
      } else {
        assert.deepEqual(chunk.byteLength, file.size % chunkSize);
      }
    }
  });

  await cleanup();

  await t.test("meta_format", async () => {
    let request = new Request(url, {
      method: "PUT",
      body: file,
    });

    let response = await backend.fetch(request);
    await response.arrayBuffer(); // To kickstart the request.

    // Checks the underlying remote to have the chunks.
    request = new Request(new URL("/", "memory:/"), {
      method: "HEAD",
    });
    response = await memory.fetch(request);
    const links = response.headers.get("Link")?.split(/,\s*/);
    assert(
      links.includes(`<${encodeURIComponent(file.name)}>`),
      "should have the metadata file named after original file",
    );

    request = new Request(new URL(`/${file.name}`, "memory:/"));
    response = await memory.fetch(request);
    const metadata = await response.json();
    assert.deepEqual(metadata.ver, 1);
    assert.deepEqual(metadata.size, file.size);
    assert.deepEqual(metadata.nchunks, Math.ceil(file.size / chunkSize));
    assert.deepEqual(metadata.md5, MD5);
  });

  await cleanup();

  await t.test("meta_format=none", async () => {
    url.searchParams.set("meta_format", "none");
    let request = new Request(url, {
      method: "PUT",
      body: file,
    });

    let response = await backend.fetch(request);
    await response.arrayBuffer(); // To kickstart the request.

    // Checks the underlying remote to have the chunks.
    request = new Request(new URL("/", "memory:/"), {
      method: "HEAD",
    });
    response = await memory.fetch(request);
    const links = response.headers.get("Link")?.split(/,\s*/);
    const chunks = Math.ceil(file.size / chunkSize);

    assert.deepEqual(links.length, chunks);

    request = new Request(new URL(`/${file.name}`, "memory:/"));
    response = await memory.fetch(request);
    assert.deepEqual(response.status, 404);
  });

  await cleanup();

  await t.test("chunk_size>file_size", async () => {
    url.searchParams.set("meta_format", "simplejson");
    url.searchParams.delete("chunk_size"); // Default is 2G, > file size of 10M

    let request = new Request(url, {
      method: "PUT",
      body: file,
    });

    let response = await backend.fetch(request);
    await response.arrayBuffer(); // To kickstart the request.

    // Checks the underlying remote to have the chunks.
    request = new Request(new URL("/", "memory:/"), {
      method: "HEAD",
    });
    response = await memory.fetch(request);
    const links = response.headers.get("Link")?.split(/,\s*/);

    assert.deepEqual(links.length, 1, "should only have 1 file");
    assert.deepEqual(
      links[0],
      `<${encodeURIComponent(file.name)}>`,
      "should have the original file name",
    );

    request = new Request(new URL(`/${file.name}`, "memory:/"));
    response = await memory.fetch(request);
    const body = await response.arrayBuffer();
    assert(
      sameBytes(new Uint8Array(body), buffer),
      "should be the original file",
    );
  });
});

await cleanup();

test("GET", async (t) => {
  url.searchParams.set("chunk_size", `${chunkSize}`);
  url.searchParams.set("start_from", `0`);

  await t.test("file > chunk_size, start_from = 0", async () => {
    let request = new Request(url, {
      method: "PUT",
      body: file,
    });
    let response = await backend.fetch(request);
    await response.arrayBuffer(); // To kickstart the request.

    request = new Request(url);
    response = await backend.fetch(request);
    const body = await response.arrayBuffer();
    assert(sameBytes(new Uint8Array(body), buffer));
  });

  await cleanup();

  url.searchParams.delete("start_from");

  await t.test("file > chunk_size, start_from = 1", async () => {
    let request = new Request(url, {
      method: "PUT",
      body: file,
    });
    let response = await backend.fetch(request);
    await response.arrayBuffer(); // To kickstart the request.

    request = new Request(url);
    response = await backend.fetch(request);
    const body = await response.arrayBuffer();
    assert(
      sameBytes(new Uint8Array(body), buffer),
      "should return original file",
    );
  });

  await cleanup();

  await t.test("file < chunk_size", async () => {
    url.searchParams.delete("chunk_size");

    let request = new Request(url, {
      method: "PUT",
      body: file,
    });
    let response = await backend.fetch(request);
    await response.arrayBuffer(); // To kickstart the request.

    request = new Request(url);
    response = await backend.fetch(request);
    const body = await response.arrayBuffer();
    assert(
      sameBytes(new Uint8Array(body), buffer),
      "should return original file",
    );
  });

  await cleanup();

  await t.test("file = chunk_size", async () => {
    url.searchParams.set("chunk_size", `${file.size}`);

    let request = new Request(url, {
      method: "PUT",
      body: file,
    });
    let response = await backend.fetch(request);
    await response.arrayBuffer(); // To kickstart the request.

    request = new Request(url);
    response = await fetch(request);
    const body = await response.arrayBuffer();
    assert(
      sameBytes(new Uint8Array(body), buffer),
      "should return original file",
    );
  });

  await cleanup();

  await t.test("Non-metadata JSON file within chunk_size", async () => {
    const json = { hello: "world" };
    const file = new Blob([JSON.stringify(json)]);
    url.searchParams.set("chunk_size", `${file.size}`);

    let request = new Request(url, {
      method: "PUT",
      body: file,
    });
    let response = await backend.fetch(request);
    await response.arrayBuffer(); // To kickstart the request.

    request = new Request(url);
    response = await backend.fetch(request);
    let body = await response.json();
    assert.deepEqual(body, json, "should return original file");

    await cleanup();

    url.searchParams.delete("chunk_size");
    request = new Request(url, {
      method: "PUT",
      body: file,
    });
    response = await backend.fetch(request);
    await response.arrayBuffer(); // To kickstart the request.

    request = new Request(url);
    response = await backend.fetch(request);
    body = await response.json();
    assert.deepEqual(body, json, "should return original file");
  });
});

test("DELETE", async (_t) => {
});
