import { crypto, encodeHex, mkBuffer } from "../../deps.js";
import { assert, assertEquals, equalBytes } from "../../dev_deps.js";
import memory from "../memory/main.js";
import backend from "./main.js";

const buffer = mkBuffer(1024 * 1024 * 10); // 10M
const file = new File([buffer], "10M.bin", {
  type: "application/octet-stream",
});
const MD5 = encodeHex(await crypto.subtle.digest("MD5", buffer));

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

Deno.test("PUT", async (t) => {
  await t.step("new file", async () => {
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
      assertEquals(link, `<${chunkName}>`, `should have ${chunkName}`);

      request = new Request(new URL(`/${chunkName}`, "memory:/"));
      response = await memory.fetch(request);
      const chunk = await response.arrayBuffer();

      if (startFrom < chunks) {
        assertEquals(chunk.byteLength, chunkSize);
      } else {
        assertEquals(chunk.byteLength, file.size % chunkSize);
      }
    }
  });

  await cleanup();

  await t.step("chunk_size, name_format, start_from", async () => {
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
      assertEquals(
        link,
        `<${chunkName}>`,
        `chunk ${startFrom} should have name of ${chunkName}, not ${link}`,
      );

      request = new Request(new URL(`/${chunkName}`, "memory:/"));
      response = await memory.fetch(request);
      const chunk = await response.arrayBuffer();

      if (startFrom < chunks - 1) {
        assertEquals(chunk.byteLength, chunkSize);
      } else {
        assertEquals(chunk.byteLength, file.size % chunkSize);
      }
    }
  });

  await cleanup();

  await t.step("meta_format", async () => {
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
    assertEquals(metadata.ver, 1);
    assertEquals(metadata.size, file.size);
    assertEquals(metadata.nchunks, Math.ceil(file.size / chunkSize));
    assertEquals(metadata.md5, MD5);
  });

  await cleanup();

  await t.step("meta_format=none", async () => {
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

    assertEquals(links.length, chunks);

    request = new Request(new URL(`/${file.name}`, "memory:/"));
    response = await memory.fetch(request);
    assertEquals(response.status, 404);
  });

  await cleanup();

  await t.step("chunk_size>file_size", async () => {
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

    assertEquals(links.length, 1, "should only have 1 file");
    assertEquals(
      links[0],
      `<${encodeURIComponent(file.name)}>`,
      "should have the original file name",
    );

    request = new Request(new URL(`/${file.name}`, "memory:/"));
    response = await memory.fetch(request);
    const body = await response.arrayBuffer();
    assert(
      equalBytes(new Uint8Array(body), buffer),
      "should be the original file",
    );
  });
});

await cleanup();

Deno.test("GET", async (t) => {
  url.searchParams.set("chunk_size", `${chunkSize}`);
  url.searchParams.set("start_from", `0`);

  await t.step("file > chunk_size, start_from = 0", async () => {
    let request = new Request(url, {
      method: "PUT",
      body: file,
    });
    let response = await backend.fetch(request);
    await response.arrayBuffer(); // To kickstart the request.

    request = new Request(url);
    response = await backend.fetch(request);
    const body = await response.arrayBuffer();
    assert(equalBytes(new Uint8Array(body), buffer));
  });

  await cleanup();

  url.searchParams.delete("start_from");

  await t.step("file > chunk_size, start_from = 1", async () => {
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
      equalBytes(new Uint8Array(body), buffer),
      "should return original file",
    );
  });

  await cleanup();

  await t.step("file < chunk_size", async () => {
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
      equalBytes(new Uint8Array(body), buffer),
      "should return original file",
    );
  });

  await cleanup();

  await t.step("file = chunk_size", async () => {
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
      equalBytes(new Uint8Array(body), buffer),
      "should return original file",
    );
  });

  await cleanup();

  await t.step("Non-metadata JSON file within chunk_size", async () => {
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
    assertEquals(body, json, "should return original file");

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
    assertEquals(body, json, "should return original file");
  });
});

Deno.test("DELETE", async (_t) => {
});
