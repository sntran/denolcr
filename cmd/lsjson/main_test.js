import { assert, assertEquals } from "../../dev_deps.js";
import { lsjson } from "./main.js";

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

Deno.test(`lsjson("${pathname}")`, async (t) => {
  const response = await lsjson(`:memory:${pathname}`);

  await t.step("returns Promise<Response>", () => {
    assert(response instanceof Response);
  });

  await t.step("with ReadableStream body", () => {
    assert(response.body instanceof ReadableStream);
  });

  await t.step("containing JSON array of objects", async () => {
    const result = await response.clone().json();
    assert(Array.isArray(result));
  });

  await t.step("whose each object is on a separate line", async () => {
    const text = await response.clone().text();
    const lines = text.trim().split("\n");

    assertEquals(lines.shift(), "[");

    for (const child of tree[pathname]) {
      const line = lines.shift().replace(/,$/, "");
      const file = JSON.parse(line);
      assertEquals(file.Name, child.replace("/", ""));
    }

    assertEquals(lines[0], "]");
  });

  await t.step("Path field is same as Name", async () => {
    const result = await response.clone().json();
    for (const file of result) {
      assertEquals(file.Path, file.Name);
    }
  });

  await t.step("each object is a chunk in body stream", async () => {
    const reader = response.body.getReader();
    let result = await reader.read();
    assertEquals(result.done, false);
    assertEquals(decoder.decode(result.value).trim(), "[");

    for (const child of tree[pathname]) {
      result = await reader?.read();
      assertEquals(result.done, false);
      const line = decoder.decode(result.value).trim().replace(/,$/, "");
      const file = JSON.parse(line);
      assertEquals(file.Name, child.replace("/", ""));
    }

    result = await reader?.read();
    assertEquals(result.done, false);
    assertEquals(decoder.decode(result.value).trim(), "]");

    result = await reader?.read();
    assertEquals(result.done, true);
  });
});

pathname = "/";
Deno.test(`lsjson("${pathname}", { recursive: true })`, async (t) => {
  const response = await lsjson(`:memory:${pathname}`, {
    recursive: "true",
  });

  await t.step("returns Promise<Response>", () => {
    assert(response instanceof Response);
  });

  await t.step("with ReadableStream body", () => {
    assert(response.body instanceof ReadableStream);
  });

  await t.step("containing JSON array of objects", async () => {
    const result = await response.clone().json();
    assert(Array.isArray(result));
  });

  await t.step(
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
