import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { backendSuite } from "@rfetch/lib/testing/suite";
import { remote } from "@rfetch/lib/testing/remote";
// Sets the global `fetch` that reads the paths of remotes.
import { fetch } from "../../mod.js";
import backend, { formatOf, locate } from "./main.js";
import { cleanPath } from "./entry.js";
import { extendedTime, ntfsTime, rar5File, zipFile } from "./testing.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Out of the archives, the remote reads and writes the files as normal.
backendSuite("archive", backend, {
  type: "archive",
  params: { remote: ":memory:/archive" },
});

/** Text that compresses, of a size. @param {number} size */
function text(size) {
  let value = "";
  for (let line = 0; value.length < size; line++) {
    value += `line ${line} of the text\n`;
  }
  return encoder.encode(value.slice(0, size));
}

/** The files of the zip file of most tests. */
const FILES = [
  { name: "folder/", time: new Date(Date.UTC(2023, 0, 2, 3, 4, 6)) },
  { name: "folder/inner.txt", data: "inner\n" },
  { name: "stored.txt", data: text(5000), method: 0 },
  { name: "deflated.txt", data: text(300_000), method: 8 },
  { name: "implicit/deep/file.txt", data: "deep" },
  { name: "empty.txt", data: "" },
  { name: "hello? sausage/êé/Hello, 世界/z.txt", data: "z" },
];

/**
 * Puts a zip file in a folder of memory, and gives a client of the archive
 * remote on that folder.
 * @param {string} folder
 * @param {Uint8Array} zip
 * @param {string} [name]
 */
async function setup(folder, zip, name = "files.zip") {
  const response = await fetch(`:memory:/${folder}/${name}`, {
    method: "PUT",
    body: zip,
  });
  assert.equal(response.status, 201);
  return remote(backend, { params: { remote: `:memory:/${folder}` } });
}

/** @param {Response} response */
async function bytesOf(response) {
  return new Uint8Array(await response.arrayBuffer());
}

test("formatOf knows zip and the formats that are zip files", () => {
  for (
    const name of ["a.zip", "b.docx", "c.xlsx", "d.epub", "e.jar", "f.kmz"]
  ) {
    assert.ok(formatOf(name), name);
  }
  // As rclone, the extension is in lower case.
  for (const name of ["a.ZIP", "a.zip.txt", "zip", "a.gz"]) {
    assert.equal(formatOf(name), undefined, name);
  }
});

test("locate splits a path at its first archive", () => {
  assert.deepEqual(
    { ...locate("s3:bucket/dir/files.zip/a/b.txt"), open: undefined },
    {
      location: "s3:bucket/dir/files.zip",
      inner: "a/b.txt",
      open: undefined,
    },
  );
  assert.equal(locate("s3:bucket/files.zip/").inner, "");
  assert.equal(locate("s3:bucket/files.zip/a/").inner, "a/");
  // An archive with no "/" after it is a file of the remote.
  assert.deepEqual(locate("s3:bucket/files.zip"), {
    location: "s3:bucket/files.zip",
    inner: null,
  });
  // The names get their percent-encoding.
  assert.equal(
    locate(":memory:/a b/c?.zip/d").location,
    ":memory:/a%20b/c%3F.zip",
  );
  assert.equal(locate("/tmp/x.zip/y").location, "/tmp/x.zip");
});

test("cleanPath is sanitize.Path of rclone", () => {
  assert.equal(cleanPath("a/b.txt"), "a/b.txt");
  assert.equal(cleanPath("./a/./b/"), "a/b");
  assert.equal(cleanPath("/a//b"), "a/b");
  assert.equal(cleanPath("."), "");
  assert.equal(cleanPath("../a"), null);
  assert.equal(cleanPath("a/../b"), null);
  assert.equal(cleanPath("a\\..\\b"), null);
  assert.equal(cleanPath("a\\b"), "a\\b");
});

test("archive lists a zip file as a folder", async () => {
  const fs = await setup("archive-list", zipFile(FILES));
  await fetch(":memory:/archive-list/book.xlsx", {
    method: "PUT",
    body: zipFile(FILES),
  });
  await fetch(":memory:/archive-list/note.txt", { method: "PUT", body: "x" });
  const root = await fs.list("");
  assert.deepEqual(
    root.map(({ Name, IsDir, Size }) => [Name, IsDir, Size]).sort(),
    [["book.xlsx", true, -1], ["files.zip", true, -1], ["note.txt", false, 1]],
  );
  // The time of the archive, to the second.
  const time = root.find(({ Name }) => Name === "files.zip").ModTime;
  assert.match(time, /T\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)$/);
  // A zip file with no "/" after it is the file.
  const raw = await fs.get("files.zip");
  assert.deepEqual(await bytesOf(raw), zipFile(FILES));
});

test("archive lists the folders of a zip file", async () => {
  const fs = await setup("archive-folders", zipFile(FILES));
  const root = await fs.list("files.zip/");
  assert.deepEqual(
    root.map(({ Name, IsDir, Size }) => [Name, IsDir, Size]).sort(),
    [
      ["deflated.txt", false, 300_000],
      ["empty.txt", false, 0],
      ["folder", true, -1],
      ["hello? sausage", true, -1],
      ["implicit", true, -1],
      ["stored.txt", false, 5000],
    ],
  );
  // The time of a folder of the index, and of a file, in UTC.
  assert.equal(
    new Date(root.find(({ Name }) => Name === "folder").ModTime).toISOString(),
    "2023-01-02T03:04:06.000Z",
  );
  assert.equal(
    new Date(root.find(({ Name }) => Name === "stored.txt").ModTime)
      .toISOString(),
    "2024-05-06T07:08:10.000Z",
  );
  assert.equal(
    root.find(({ Name }) => Name === "stored.txt").MimeType,
    "text/plain; charset=utf-8",
  );
  assert.deepEqual(
    (await fs.list("files.zip/implicit/deep/")).map(({ Name }) => Name),
    ["file.txt"],
  );
  assert.deepEqual(
    (await fs.list("files.zip/hello? sausage/êé/Hello, 世界/"))
      .map(({ Name }) => Name),
    ["z.txt"],
  );
  assert.equal((await fs.get("files.zip/missing/")).status, 404);
  assert.equal((await fs.get("files.zip/stored.txt/")).status, 404);
  const head = await fs.head("files.zip/folder/");
  assert.equal(head.status, 200);
  assert.match(head.headers.get("Content-Type"), /^text\/html/);
});

test("archive reads the files of a zip file, and their ranges", async () => {
  const fs = await setup("archive-read", zipFile(FILES));
  for (
    const { name, data = "" } of FILES.filter(({ name }) => !name.endsWith("/"))
  ) {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    const response = await fs.get(`files.zip/${name}`);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get("Content-Length"), `${bytes.length}`);
    assert.deepEqual(await bytesOf(response), bytes, name);
  }
  for (const name of ["stored.txt", "deflated.txt"]) {
    const data = FILES.find((file) => file.name === name).data;
    for (
      const [start, end] of [[0, 9], [1000, 1999], [
        data.length - 7,
        data.length - 1,
      ]]
    ) {
      const response = await fs.get(`files.zip/${name}`, {
        Range: `bytes=${start}-${end}`,
      });
      assert.equal(response.status, 206);
      assert.equal(
        response.headers.get("Content-Range"),
        `bytes ${start}-${end}/${data.length}`,
      );
      assert.deepEqual(await bytesOf(response), data.subarray(start, end + 1));
    }
    const outside = await fs.get(`files.zip/${name}`, {
      Range: `bytes=${data.length}-`,
    });
    assert.equal(outside.status, 416);
  }
  const head = await fs.head("files.zip/deflated.txt");
  assert.equal(head.headers.get("Content-Length"), "300000");
  assert.equal(
    head.headers.get("Last-Modified"),
    "Mon, 06 May 2024 07:08:10 GMT",
  );
  assert.equal(head.headers.get("Accept-Ranges"), "bytes");
  assert.equal((await fs.get("files.zip/missing.txt")).status, 404);
  assert.equal((await fs.get("files.zip/folder")).status, 404);
  assert.equal((await fs.get("missing.zip/a.txt")).status, 404);
});

test("archive is read only in a zip file", async () => {
  const fs = await setup("archive-read-only", zipFile(FILES));
  for (const init of [{ method: "PUT", body: "x" }, { method: "DELETE" }]) {
    const response = await fs.send("files.zip/stored.txt", init);
    assert.equal(response.status, 403);
    assert.equal(await response.text(), "read only file system");
  }
  assert.equal((await fs.delete("files.zip/")).status, 403);
  // The zip file itself can change.
  assert.equal((await fs.put("files.zip", zipFile([]))).status, 201);
  assert.deepEqual(await fs.list("files.zip/"), []);
});

test("archive reads ZIP64 and data before a zip file", async () => {
  for (
    const [folder, zip] of [
      ["archive-zip64", zipFile(FILES, { zip64: true })],
      ["archive-prefix", zipFile(FILES, { prefix: text(1234) })],
      ["archive-comment", zipFile(FILES, { comment: "a comment" })],
    ]
  ) {
    const fs = await setup(folder, zip);
    assert.equal((await fs.list("files.zip/")).length, 6, folder);
    const response = await fs.get("files.zip/deflated.txt", {
      Range: "bytes=299990-",
    });
    assert.deepEqual(
      await bytesOf(response),
      FILES[3].data.subarray(299990),
      folder,
    );
    assert.equal(
      decoder.decode(await bytesOf(await fs.get("files.zip/folder/inner.txt"))),
      "inner\n",
      folder,
    );
  }
});

test("archive gives the error of Go for ZIP64 with data before it", async () => {
  // The offset of the ZIP64 end record is from the start of the zip file:
  // Go does not read it there.
  const fs = await setup(
    "archive-both",
    zipFile(FILES, { zip64: true, prefix: text(99) }),
  );
  const response = await fs.get("files.zip/");
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "zip: not a valid zip file");
});

test("archive reads the times of the extra fields, as Go", async () => {
  const time = new Date(Date.UTC(2021, 6, 8, 9, 10, 11));
  const zip = zipFile([
    { name: "extended.txt", data: "a", extra: extendedTime(time) },
    // 2021-07-08T09:10:11.1234567Z, in 100 ns after 1601.
    {
      name: "ntfs.txt",
      data: "b",
      extra: ntfsTime(
        (BigInt(Date.UTC(2021, 6, 8, 9, 10, 11)) / 1000n + 11_644_473_600n) *
            10_000_000n + 1_234_567n,
      ),
    },
  ]);
  const fs = await setup("archive-times", zip);
  const list = await fs.list("files.zip/");
  assert.equal(
    new Date(list.find(({ Name }) => Name === "extended.txt").ModTime)
      .toISOString(),
    "2021-07-08T09:10:11.000Z",
  );
  // As rclone, the time is to the second.
  assert.equal(
    new Date(list.find(({ Name }) => Name === "ntfs.txt").ModTime)
      .toISOString(),
    "2021-07-08T09:10:11.000Z",
  );
});

test("archive skips the names that go out of a zip file", async () => {
  const zip = zipFile([
    { name: "../evil.txt", data: "x" },
    { name: "a/../../evil.txt", data: "x" },
    { name: "a\\..\\evil.txt", data: "x" },
    { name: "/absolute.txt", data: "y" },
    { name: "./dot/file.txt", data: "z" },
    { name: "./", data: "" },
  ]);
  const fs = await setup("archive-names", zip);
  assert.deepEqual(
    (await fs.list("files.zip/")).map(({ Name }) => Name).sort(),
    ["absolute.txt", "dot"],
  );
  assert.equal(
    decoder.decode(await bytesOf(await fs.get("files.zip/absolute.txt"))),
    "y",
  );
  assert.equal((await fs.get("files.zip/../evil.txt")).status, 404);
});

test("archive gives the errors of a zip file", async () => {
  const fs = await setup(
    "archive-errors",
    zipFile([
      { name: "secret.txt", data: "x", flags: 1 },
      { name: "bzip2.txt", data: "x", method: 12 },
      { name: "bad.txt", data: "some data", crc: 1234 },
    ]),
  );
  const secret = await fs.get("files.zip/secret.txt");
  assert.equal(secret.status, 501);
  assert.match(await secret.text(), /password/);
  const bzip2 = await fs.get("files.zip/bzip2.txt");
  assert.equal(bzip2.status, 501);
  assert.equal(await bzip2.text(), "zip: unsupported compression algorithm");
  // The data come, then the stream gives an error at the end.
  const bad = await fs.get("files.zip/bad.txt");
  assert.equal(bad.status, 200);
  await assert.rejects(bad.arrayBuffer(), /checksum error/);
  // A range is not checked, as rclone.
  const part = await fs.get("files.zip/bad.txt", { Range: "bytes=0-3" });
  assert.equal(decoder.decode(await bytesOf(part)), "some");

  await fetch(":memory:/archive-errors/broken.zip", {
    method: "PUT",
    body: text(5000),
  });
  const broken = await fs.get("broken.zip/");
  assert.equal(broken.status, 500);
  assert.equal(await broken.text(), "zip: not a valid zip file");
  await fetch(":memory:/archive-errors/empty.zip", {
    method: "PUT",
    body: new Uint8Array(0),
  });
  assert.equal((await fs.get("empty.zip/")).status, 500);
});

test("archive reads a zip file of the command zip", async () => {
  const zip = await import("node:child_process").then(({ spawnSync }) => {
    const result = spawnSync("zip", ["-q", "-", "-"], {
      input: text(10_000),
    });
    return result.status === 0 ? new Uint8Array(result.stdout) : null;
  });
  if (!zip) return;
  // The command writes the data descriptor of a stream, with a "-" name.
  const fs = await setup("archive-command", zip);
  const list = await fs.list("files.zip/");
  assert.deepEqual(list.map(({ Name, Size }) => [Name, Size]), [["-", 10_000]]);
  assert.deepEqual(await bytesOf(await fs.get("files.zip/-")), text(10_000));
});

test("archive reads the remote in its path, as rclone", async () => {
  await fetch(":memory:/archive-path/a b/files.zip", {
    method: "PUT",
    body: zipFile(FILES),
  });
  const response = await fetch(
    ":archive::memory:/archive-path/a%20b/files.zip/folder/inner.txt",
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "inner\n");
  const list = await fetch(":archive::memory:/archive-path/a%20b/");
  assert.equal(list.status, 200);
  assert.match(await list.text(), /href="files.zip\/"/);
  // The option remote can be the zip file.
  const inner = remote(backend, {
    params: { remote: ":memory:/archive-path/a b/files.zip" },
  });
  assert.deepEqual(
    (await inner.list("implicit/")).map(({ Name }) => Name),
    ["deep"],
  );
});

/** The text of folder/large.txt in the RAR files of testdata. */
function rarText() {
  let value = "";
  for (let line = 0; value.length < 20000; line++) {
    value += `line ${line} of the text\n`;
  }
  return encoder.encode(value.slice(0, 20000));
}

/**
 * Puts the RAR files of testdata in a folder of memory, and gives a client
 * of the archive remote on that folder.
 */
async function rarFixtures() {
  const folder = new URL("./testdata/", import.meta.url);
  for (
    const name of readdirSync(folder).filter((name) => name.endsWith(".rar"))
  ) {
    await fetch(`:memory:/archive-rar/${name}`, {
      method: "PUT",
      body: readFileSync(new URL(name, folder)),
    });
  }
  return remote(backend, { params: { remote: ":memory:/archive-rar" } });
}

test("archive reads the RAR files of RAR 6.20 in store mode", async () => {
  const fs = await rarFixtures();
  for (const name of ["store5.rar", "store4.rar", "solid5.rar"]) {
    const root = await fs.list(`${name}/`);
    assert.deepEqual(
      root.map(({ Name, IsDir, Size }) => [Name, IsDir, Size]).sort(),
      [
        ["a.txt", false, 6],
        ["empty folder", true, -1],
        ["empty.txt", false, 0],
        ["folder", true, -1],
        ["êé", true, -1],
      ],
      name,
    );
    // The time of a file, also with the extended time of RAR4.
    assert.equal(
      new Date(root.find(({ Name }) => Name === "a.txt").ModTime).toISOString(),
      "2024-05-06T07:08:09.000Z",
      name,
    );
    assert.deepEqual(
      (await fs.list(`${name}/êé/`)).map(({ Name }) => Name),
      ["Hello, 世界.txt"],
      name,
    );
    assert.equal(
      decoder.decode(await bytesOf(await fs.get(`${name}/êé/Hello, 世界.txt`))),
      "z\n",
    );
    assert.equal(
      decoder.decode(await bytesOf(await fs.get(`${name}/a.txt`))),
      "hello\n",
    );
    assert.equal((await bytesOf(await fs.get(`${name}/empty.txt`))).length, 0);
    assert.deepEqual(
      await bytesOf(await fs.get(`${name}/folder/large.txt`)),
      rarText(),
    );
    const part = await fs.get(`${name}/folder/large.txt`, {
      Range: "bytes=12345-12399",
    });
    assert.equal(part.status, 206);
    assert.deepEqual(await bytesOf(part), rarText().subarray(12345, 12400));
    const random = await fs.get(`${name}/folder/deep/random.bin`);
    assert.equal((await bytesOf(random)).length, 3000);
  }
});

test("archive gives 501 for the RAR files that it cannot read", async () => {
  const fs = await rarFixtures();
  for (
    const [path, message] of [
      [
        "compressed5.rar/folder/large.txt",
        "rar: a compressed file is not supported",
      ],
      [
        "compressed4.rar/folder/large.txt",
        "rar: a compressed file is not supported",
      ],
      ["password5.rar/a.txt", "rar: a file with a password is not supported"],
      ["password4.rar/a.txt", "rar: a file with a password is not supported"],
      [
        "volumes.part1.rar/folder/large.txt",
        "rar: a file in more than one volume is not supported",
      ],
      [
        "headers5.rar/",
        "rar: an archive with a password on its headers is not supported",
      ],
    ]
  ) {
    const response = await fs.get(path);
    assert.equal(response.status, 501, path);
    assert.equal(await response.text(), message, path);
  }
  // The files in store mode of a compressed archive can be read.
  assert.equal(
    decoder.decode(await bytesOf(await fs.get("compressed5.rar/a.txt"))),
    "hello\n",
  );
  // A part of a file that starts in a volume before is not in the list.
  assert.deepEqual(
    (await fs.list("volumes.part2.rar/folder/")).map(({ Name }) => Name),
    ["deep"],
  );
  assert.deepEqual(
    (await fs.list("volumes.part1.rar/folder/")).map((
      { Name, Size },
    ) => [Name, Size]),
    [["large.txt", 20000]],
  );
});

test("archive reads the headers of a large RAR file in parts", async () => {
  const big = new Uint8Array(300_000).map((_, index) => index * 7);
  const files = [{ name: "big.bin", data: big }];
  for (let index = 0; index < 40; index++) {
    files.push({
      name: `many/file${index}.txt`,
      data: "x".repeat(9000 + index),
    });
  }
  files.push({ name: "last.txt", data: "the end" });
  const fs = await setup("archive-rar-large", rar5File(files), "files.rar");
  const many = await fs.list("files.rar/many/");
  assert.equal(many.length, 40);
  assert.equal(many.find(({ Name }) => Name === "file39.txt").Size, 9039);
  assert.equal(
    decoder.decode(await bytesOf(await fs.get("files.rar/last.txt"))),
    "the end",
  );
  assert.deepEqual(await bytesOf(await fs.get("files.rar/big.bin")), big);
  const part = await fs.get("files.rar/big.bin", { Range: "bytes=-10" });
  assert.deepEqual(await bytesOf(part), big.subarray(-10));
});

test("archive gives the errors of a RAR file that is not correct", async () => {
  const rar = rar5File([{ name: "a.txt", data: "abc" }]);
  const bad = rar.slice();
  // A byte of the header of the file.
  bad[30] ^= 0xff;
  const fs = await setup("archive-rar-errors", bad, "bad.rar");
  const response = await fs.get("bad.rar/");
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "rar: header CRC error");
  await fetch(":memory:/archive-rar-errors/text.rar", {
    method: "PUT",
    body: "not a RAR file",
  });
  const text = await fs.get("text.rar/");
  assert.equal(text.status, 500);
  assert.equal(await text.text(), "rar: not a valid RAR file");
  // The end of the file is not there.
  await fetch(":memory:/archive-rar-errors/short.rar", {
    method: "PUT",
    body: rar.subarray(0, 25),
  });
  assert.equal((await fs.get("short.rar/")).status, 500);
});
