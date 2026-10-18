import { test } from "node:test";
import assert from "node:assert/strict";
import { listen } from "@rfetch/lib/testing/server";
import memory from "@rfetch/memory";
import { fetch } from "../../mod.js";
import { LineStream, lsjson } from "./main.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const tree = {
  "/": ["A/", "b", "C"],
  "/A/": ["a", "c", "D"],
  "/A/D/": ["E"],
  "/A/D/E/": ["f"],
  "/C/": ["d"],
};

const files = [
  "/A/a",
  "/A/c",
  "/A/D/E/f",
  "/b",
  "/C/d",
];

// Uploads fixtures
for (const fileName of files) {
  await fetch(`:memory:${fileName}`, {
    method: "PUT",
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": `${encoder.encode(fileName).byteLength}`,
    },
    body: fileName,
  });
}

let pathname = "/";

test(`lsjson("${pathname}")`, async (t) => {
  const response = await lsjson(`:memory:${pathname}`);

  await t.test("returns Promise<Response>", () => {
    assert(response instanceof Response);
  });

  await t.test("with ReadableStream body", () => {
    assert(response.body instanceof ReadableStream);
  });

  await t.test("containing JSON array of objects", async () => {
    const result = await response.clone().json();
    assert(Array.isArray(result));
  });

  await t.test("whose each object is on a separate line", async () => {
    const text = await response.clone().text();
    const lines = text.trim().split("\n");

    assert.deepEqual(lines.shift(), "[");

    for (const child of tree[pathname]) {
      const line = lines.shift().replace(/,$/, "");
      const file = JSON.parse(line);
      assert.deepEqual(file.Name, child.replace("/", ""));
    }

    assert.deepEqual(lines[0], "]");
  });

  await t.test("Path field is same as Name", async () => {
    const result = await response.clone().json();
    for (const file of result) {
      assert.deepEqual(file.Path, file.Name);
    }
  });

  await t.test("each object is a chunk in body stream", async () => {
    const reader = response.body.getReader();
    let result = await reader.read();
    assert.deepEqual(result.done, false);
    assert.deepEqual(decoder.decode(result.value).trim(), "[");

    for (const child of tree[pathname]) {
      result = await reader?.read();
      assert.deepEqual(result.done, false);
      const line = decoder.decode(result.value).trim().replace(/,$/, "");
      const file = JSON.parse(line);
      assert.deepEqual(file.Name, child.replace("/", ""));
    }

    result = await reader?.read();
    assert.deepEqual(result.done, false);
    assert.deepEqual(decoder.decode(result.value).trim(), "]");

    result = await reader?.read();
    assert.deepEqual(result.done, true);
  });
});

pathname = "/";
test(`lsjson("${pathname}", { recursive: true })`, async (t) => {
  const response = await lsjson(`:memory:${pathname}`, {
    recursive: "true",
  });

  await t.test("returns Promise<Response>", () => {
    assert(response instanceof Response);
  });

  await t.test("with ReadableStream body", () => {
    assert(response.body instanceof ReadableStream);
  });

  await t.test("containing JSON array of objects", async () => {
    const result = await response.clone().json();
    assert(Array.isArray(result));
  });

  await t.test(
    "Path field only show folders below the remote path being listed",
    async () => {
      const result = await response.clone().json();
      const children = tree[pathname];

      for (const { Path, Name } of result) {
        assert(Path.includes(Name));
        assert(children.some((child) => {
          if (`${Path}/` === child) return true;
          if (Path.startsWith(child)) return true;
          return false;
        }));
      }
    },
  );
});

test("lsjson gives the names with no percent-encoding", async () => {
  const name = "a b?#%.txt";
  await fetch(`:memory:/names/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: "a",
  });

  const result = await lsjson(":memory:/names/").then((res) => res.json());
  assert.deepEqual(result.map(({ Name, Path }) => ({ Name, Path })), [
    { Name: name, Path: name },
  ]);
});

/** Puts the files, with percent-encoding in each name of each path. */
async function putAll(location, paths) {
  for (const path of paths) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`${location}${encoded}`, {
      method: "PUT",
      headers: { "Content-Length": `${encoder.encode(path).byteLength}` },
      body: path,
    });
    assert.equal(response.status, 201, path);
  }
}

/** The paths of the entries of `lsjson --recursive`, in order. */
async function walk(location) {
  const result = await lsjson(location, { recursive: "true" })
    .then((response) => response.json());
  return result.map(({ Path, IsDir, Size }) => ({ Path, IsDir, Size }))
    .sort((a, b) => a.Path < b.Path ? -1 : +(a.Path > b.Path));
}

/** Folders and files with names that have "?", "#", "%" and spaces. */
const HARD = ["a?b/c#d/e%f.txt", "a?b/g h.txt", "i%20j/k?.txt", "l#/m"];

/** The entries of the files of HARD and of their folders. */
function entries(paths) {
  const all = new Map();
  for (const path of paths) {
    const names = path.split("/");
    for (let i = 1; i < names.length; i++) {
      const folder = names.slice(0, i).join("/");
      all.set(folder, { Path: folder, IsDir: true, Size: -1 });
    }
    all.set(path, {
      Path: path,
      IsDir: false,
      Size: encoder.encode(path).length,
    });
  }
  return [...all.values()].sort((a, b) =>
    a.Path < b.Path ? -1 : +(a.Path > b.Path)
  );
}

test("lsjson --recursive keeps the names with ? and # in folders", async () => {
  await putAll(":memory:/recursive/", HARD);
  assert.deepEqual(await walk(":memory:/recursive/"), entries(HARD));
});

test("lsjson lists one file with a hard name", async () => {
  const result = await lsjson(
    `:memory:/recursive/a%3Fb/${encodeURIComponent("g h.txt")}`,
  )
    .then((response) => response.json());
  assert.deepEqual(result.map(({ Name }) => Name), ["g h.txt"]);
});

test("lsjson reads a connection string with a / in a value", async () => {
  // "test-password", obscured by rclone.
  const password = "4OSlj-ZYMGdEIGjcWg_gc-DL4O3TFAvr4ct_yV4";
  const location =
    `:crypt,remote=':memory:/lsjson/crypt',password=${password}:`;
  await putAll(location, HARD);
  assert.deepEqual(await walk(location), entries(HARD));
});

test("lsjson --recursive gives an error for a folder it cannot list", async () => {
  // A server of the memory backend, with no list of the folder "bad".
  const server = await listen((request) =>
    new URL(request.url).pathname === "/lsjson-error/bad/"
      ? new Response("no list", { status: 500 })
      : memory.fetch(request)
  );
  try {
    await putAll(":memory:/lsjson-error/", ["bad/a.txt", "good/b.txt"]);
    const response = await lsjson(`:http,url='${server.url}lsjson-error/':`, {
      recursive: "true",
    });
    assert.equal(response.status, 200);
    await assert.rejects(response.text(), /Cannot list bad: 50\d/);
  } finally {
    await server.close();
  }
});

test("lsjson lists a folder with no / at the end, as rclone", async () => {
  await putAll(":memory:/no-slash/", ["tree/a.txt", "tree/b/c.txt", "file"]);
  assert.deepEqual(await walk(":memory:/no-slash/tree"), [
    { Path: "a.txt", IsDir: false, Size: 10 },
    { Path: "b", IsDir: true, Size: -1 },
    { Path: "b/c.txt", IsDir: false, Size: 12 },
  ]);
  // A file of the name is a file, as for rclone.
  const result = await lsjson(":memory:/no-slash/file")
    .then((response) => response.json());
  assert.deepEqual(result.map(({ Path, IsDir }) => ({ Path, IsDir })), [
    { Path: "file", IsDir: false },
  ]);
});

test("lsjson gives 404 for a path that is not found, as rclone", async () => {
  await putAll(":memory:/not-found/", ["a.txt"]);
  for (const path of ["nosuch", "nosuch.txt", "nosuch/"]) {
    const response = await lsjson(`:memory:/not-found/${path}`);
    assert.equal(response.status, 404, path);
    await response.body?.cancel();
  }
});

test("lsjson gives a folder with no time the default time of rclone", async () => {
  const items = await lsjson(":memory:/A/").then((response) => response.json());
  const folder = items.find(({ Name }) => Name === "D");
  assert.equal(folder.IsDir, true);
  assert.equal(folder.ModTime, "2000-01-01T00:00:00Z");
});

test("LineStream reads the body of lsjson in chunks of any size", async () => {
  const text = [
    "[",
    '{"Path":"a","Name":"a","IsDir":false},',
    '{"Path":"日本語 b","Name":"日本語 b","IsDir":false},',
    '{"Path":"C","Name":"C","IsDir":true}',
    "]",
    "",
  ].join("\n");
  const bytes = encoder.encode(text);
  // All in one chunk, a chunk for each byte (thus a character of three
  // bytes is in three chunks), and chunks of 7 bytes.
  for (const size of [bytes.length, 1, 7]) {
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += size) {
          controller.enqueue(bytes.slice(i, i + size));
        }
        controller.close();
      },
    });
    const lines = body.pipeThrough(
      new LineStream(({ Path, IsDir }) => IsDir ? undefined : Path),
    );
    assert.equal(await new Response(lines).text(), "a\n日本語 b\n", `${size}`);
  }
});

test("LineStream gives an error for a line that is not an item", async () => {
  const body = new Response('[\n{"Path":"a",\n]\n').body;
  const lines = body.pipeThrough(new LineStream(({ Path }) => Path));
  await assert.rejects(new Response(lines).text(), SyntaxError);
});
