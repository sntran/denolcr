/**
 * The tests of the doi backend, on a test server of a resolver of DOIs, of
 * Zenodo, of an InvenioRDM server and of Dataverse. When rclone is in the
 * PATH, or when RCLONE is the path of rclone, the tests also compare the
 * lists and the files of rfetch with the lists and the files of rclone.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";

import { listen } from "@rfetch/lib/testing/server";
// Sets the global `fetch` that reads the paths of remotes.
import { lsjson } from "../../mod.js";
import backend, { linksOf, parseDoi } from "./main.js";

const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

/** The files of the datasets, by their paths on the test server. */
const FILES = {
  "/api/files/README.md": "This is a dataset.",
  "/api/files/data.txt": "Some data",
  "/api/files/sub/deep.csv": "a,b\n1,2\n",
  "/inv/files/table.tsv": "x\ty\n",
  "/api/access/datafile/42": "original,csv\n",
  "/api/access/datafile/43": "hello",
};

const md5 = (text) => createHash("md5").update(text).digest("hex");

/** The DOIs of the tests, and the URLs that the resolver gives. */
const DOIS = {
  "10.5281/zenodo.2600782": (origin) => `${origin}/record/2600782`,
  "10.1234/inv.1": (origin) => `${origin}/records/abc`,
  "10.7910/DVN/ABC": (origin) =>
    `${origin}/citation?persistentId=doi:10.7910/DVN/ABC`,
};

/** The requests of the test server, for the tests of the cache. */
const requests = [];

const server = await listen((request) => {
  const url = new URL(request.url);
  const { origin, pathname } = url;
  requests.push(`${pathname}${url.search}`);
  const json = (value, headers = {}) =>
    Response.json(value, { headers: { ...headers } });
  if (pathname.startsWith("/api/handles/")) {
    const name = pathname.slice("/api/handles/".length);
    const landing = DOIS[name];
    if (!landing) {
      return json({ responseCode: 100, handle: name });
    }
    return json({
      responseCode: 1,
      handle: name,
      values: [
        { index: 100, type: "HS_ADMIN", data: { format: "admin" } },
        {
          index: 1,
          type: "URL",
          data: { format: "string", value: landing(origin) },
        },
      ],
    });
  }
  // The page of a record of Zenodo, with no header Link: on another host
  // than zenodo.org, the backend finds its API from its path.
  if (pathname === "/record/2600782") {
    return new Response("<html></html>", {
      headers: { "Content-Type": "text/html" },
    });
  }
  if (pathname === "/api/records/2600782") {
    return json({ links: { self: `${origin}/api/records/2600782` } });
  }
  if (pathname === "/api/records/2600782/files") {
    return json({
      entries: [
        ["README.md", "text/markdown"],
        ["data.txt", "text/plain"],
        ["sub/deep.csv", "text/csv"],
      ].map(([key, mimetype]) => {
        const text = FILES[`/api/files/${key}`];
        return {
          key,
          checksum: `md5:${md5(text)}`,
          size: new TextEncoder().encode(text).length,
          updated: "2025-01-02T03:04:05.678901+00:00",
          mimetype,
          links: { content: `${origin}/api/files/${key}` },
        };
      }),
    });
  }
  // An InvenioRDM server: the page of the record has the link to its API.
  if (pathname === "/records/abc") {
    return new Response("<html></html>", {
      headers: {
        "Content-Type": "text/html",
        Link:
          `<${origin}/inv/api/records/abc> ; rel="linkset" ; type="application/linkset+json"`,
      },
    });
  }
  if (pathname === "/inv/api/records/abc") {
    return json({ links: { self: `${origin}/inv/api/records/abc` } });
  }
  if (pathname === "/inv/api/records/abc/files") {
    return json({
      entries: [{
        key: "table.tsv",
        checksum: `md5:${md5(FILES["/inv/files/table.tsv"])}`,
        size: 4,
        updated: "2024-06-07T08:09:10Z",
        mimetype: "text/tab-separated-values",
        links: { content: `${origin}/inv/files/table.tsv` },
      }],
    });
  }
  if (pathname === "/api/datasets/:persistentId/") {
    assert.equal(url.searchParams.get("persistentId"), "doi:10.7910/DVN/ABC");
    return json({
      status: "OK",
      data: {
        latestVersion: {
          lastUpdateTime: "2024-05-01T10:00:00Z",
          files: [
            {
              directoryLabel: "sub",
              dataFile: {
                id: 42,
                filename: "a.tab",
                contentType: "text/tab-separated-values",
                filesize: 10,
                originalFileFormat: "text/csv",
                originalFileSize: 13,
                originalFileName: "a.csv",
                md5: md5(FILES["/api/access/datafile/42"]),
              },
            },
            {
              dataFile: {
                id: 43,
                filename: "b.txt",
                contentType: "text/plain",
                filesize: 5,
                md5: md5("hello"),
              },
            },
          ],
        },
      },
    });
  }
  const text = FILES[pathname];
  if (text === undefined) return new Response(null, { status: 404 });
  // The server of the files reads one range, as most servers.
  const bytes = new TextEncoder().encode(text);
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("Range") ?? "");
  if (match) {
    const [start, end] = [Number(match[1]), Number(match[2])];
    return new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}` },
    });
  }
  return new Response(bytes);
});
after(() => server.close());

const resolver = new URL("/api", server.url).href;

/**
 * The location of a path in a dataset, for the fetch of rfetch.
 * @param {string} doi
 * @param {string} path
 */
const locationOf = (doi, path = "", provider = "") =>
  `:doi,doi='${doi}',doi_resolver_api_url='${resolver}'${
    provider ? `,provider=${provider}` : ""
  }:${path}`;

/**
 * The names, the sizes, the types and the times of a list of lsjson.
 * @param {string} location
 */
async function items(location, flags = {}) {
  const response = await lsjson(location, flags);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json())
    .map(({ Path, Size, MimeType, ModTime, IsDir }) => ({
      Path,
      Size,
      MimeType,
      ModTime,
      IsDir,
    }))
    .sort((a, b) => a.Path < b.Path ? -1 : 1);
}

test("parseDoi reads a DOI as rclone", () => {
  for (
    const [text, doi] of [
      ["10.1000/182", "10.1000/182"],
      ["doi:10.1000/182", "10.1000/182"],
      ["doi://10.1000/182", "10.1000/182"],
      ["https://doi.org/10.1000/182", "10.1000/182"],
      ["https://dx.doi.org/10.1000/182?x=1", "10.1000/182"],
      ["https://doi.org/10.1000/a%20b", "10.1000/a b"],
      // As rclone: the prefix is "doi:" in lower case.
      ["DOI:10.1000/182", "DOI:10.1000/182"],
    ]
  ) {
    assert.equal(parseDoi(text), doi, text);
  }
});

test("linksOf reads the header Link as rclone", () => {
  assert.deepEqual(
    linksOf(
      '<https://zenodo.org/api/records/15063252> ; rel="linkset" ; type="application/linkset+json"',
    ),
    [{
      href: "https://zenodo.org/api/records/15063252",
      rel: "linkset",
      type: "application/linkset+json",
    }],
  );
  assert.deepEqual(
    linksOf('<https://a/?page=2>; rel="next", <https://a/?page=5>; REL=last'),
    [
      { href: "https://a/?page=2", rel: "next", type: "" },
      { href: "https://a/?page=5", rel: "last", type: "" },
    ],
  );
});

describe("doi", () => {
  test("lists a dataset of Zenodo, with its folders", async () => {
    assert.deepEqual(
      await items(locationOf("10.5281/zenodo.2600782"), { recursive: true }),
      [
        {
          Path: "README.md",
          Size: 18,
          MimeType: "text/markdown",
          ModTime: "2025-01-02T03:04:05Z",
          IsDir: false,
        },
        {
          Path: "data.txt",
          Size: 9,
          MimeType: "text/plain",
          ModTime: "2025-01-02T03:04:05Z",
          IsDir: false,
        },
        {
          Path: "sub",
          Size: -1,
          MimeType: "inode/directory",
          ModTime: (await items(locationOf("10.5281/zenodo.2600782")))
            .find((item) => item.Path === "sub").ModTime,
          IsDir: true,
        },
        {
          Path: "sub/deep.csv",
          Size: 8,
          MimeType: "text/csv",
          ModTime: "2025-01-02T03:04:05Z",
          IsDir: false,
        },
      ],
    );
  });

  test("reads a file, its headers and its ranges", async () => {
    const location = locationOf("10.5281/zenodo.2600782", "sub/deep.csv");
    const response = await fetch(location);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "a,b\n1,2\n");
    assert.equal(response.headers.get("Content-Length"), "8");
    assert.equal(
      response.headers.get("Last-Modified"),
      "Thu, 02 Jan 2025 03:04:05 GMT",
    );
    const range = await fetch(location, { headers: { Range: "bytes=2-4" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("Content-Range"), "bytes 2-4/8");
    assert.equal(await range.text(), "b\n1");
    const outside = await fetch(location, { headers: { Range: "bytes=8-" } });
    await outside.body?.cancel();
    assert.equal(outside.status, 416);
    // HEAD reads only the list.
    const before = requests.length;
    const head = await fetch(location, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("Content-Type"), "text/csv");
    assert.equal(requests.length, before, "HEAD sent a request");
  });

  test("reads Zenodo with the option provider", async () => {
    const list = await items(
      locationOf("10.5281/zenodo.2600782", "", "zenodo"),
    );
    assert.deepEqual(list.map(({ Path }) => Path), [
      "README.md",
      "data.txt",
      "sub",
    ]);
    const response = await fetch(
      locationOf("10.5281/zenodo.2600782", "README.md", "zenodo"),
    );
    assert.equal(await response.text(), "This is a dataset.");
  });

  test("keeps the list in memory", async () => {
    const location = locationOf("10.5281/zenodo.2600782");
    await items(location);
    const before = requests.length;
    await items(location);
    assert.equal(requests.length, before);
  });

  test("finds the API of an InvenioRDM server in the header Link", async () => {
    assert.deepEqual(await items(locationOf("10.1234/inv.1")), [{
      Path: "table.tsv",
      Size: 4,
      MimeType: "text/tab-separated-values",
      ModTime: "2024-06-07T08:09:10Z",
      IsDir: false,
    }]);
    const response = await fetch(locationOf("10.1234/inv.1", "table.tsv"));
    assert.equal(await response.text(), "x\ty\n");
  });

  test("lists a dataset of Dataverse, in the original formats", async () => {
    const listed = await items(locationOf("10.7910/DVN/ABC"), {
      recursive: true,
    });
    assert.deepEqual(listed.filter((item) => !item.IsDir), [
      {
        Path: "b.txt",
        Size: 5,
        MimeType: "text/plain",
        ModTime: "2024-05-01T10:00:00Z",
        IsDir: false,
      },
      {
        Path: "sub/a.csv",
        Size: 13,
        MimeType: "text/csv",
        ModTime: "2024-05-01T10:00:00Z",
        IsDir: false,
      },
    ]);
    const response = await fetch(locationOf("10.7910/DVN/ABC", "sub/a.csv"));
    assert.equal(await response.text(), "original,csv\n");
  });

  test("gives 404 for a DOI, a file or a folder that does not exist", async () => {
    for (
      const location of [
        locationOf("10.9999/none"),
        locationOf("10.5281/zenodo.2600782", "missing.txt"),
        locationOf("10.5281/zenodo.2600782", "missing/"),
      ]
    ) {
      const response = await fetch(location);
      await response.body?.cancel();
      assert.equal(response.status, 404, location);
    }
  });

  test("is read only", async () => {
    for (const method of ["PUT", "DELETE", "COPY", "MOVE", "PATCH"]) {
      const response = await backend.fetch(
        new Request(
          `http://doi.test/a.txt?doi=10.5281/zenodo.2600782&doi_resolver_api_url=${
            encodeURIComponent(resolver)
          }`,
          { method },
        ),
      );
      assert.equal(response.status, 403, method);
      assert.equal(await response.text(), "doi remotes are read only");
    }
  });
});

describe("doi and rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  /**
   * Runs rclone. It does not wait with spawnSync: the test server is in this
   * process, and must answer rclone.
   * @param {...string} args
   * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
   */
  const rclone = (...args) =>
    new Promise((resolve) => {
      execFile(RCLONE, args, {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: "/nonexistent", TZ: "UTC" },
      }, (error, stdout, stderr) =>
        resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr }));
    });

  /** The lsjson of rclone for a DOI, with the fields of the tests. */
  const rcloneItems = async (doi, provider = "") => {
    const remote = `:doi,doi='${doi}',doi_resolver_api_url='${resolver}'${
      provider ? `,provider=${provider}` : ""
    }:`;
    const { status, stdout, stderr } = await rclone("lsjson", "-R", remote);
    assert.equal(status, 0, stderr);
    return JSON.parse(stdout)
      .map(({ Path, Size, MimeType, ModTime, IsDir }) => ({
        Path,
        Size,
        MimeType,
        ModTime,
        IsDir,
      }))
      .sort((a, b) => a.Path < b.Path ? -1 : 1);
  };

  before(() => {
    process.env.TZ = "UTC";
  });

  for (
    const [name, doi, provider] of [
      ["Zenodo", "10.5281/zenodo.2600782", "zenodo"],
      ["a record", "10.5281/zenodo.2600782", ""],
      ["InvenioRDM", "10.1234/inv.1", ""],
      ["Dataverse", "10.7910/DVN/ABC", ""],
    ]
  ) {
    test(`gives the files of rclone for a dataset of ${name}`, async () => {
      const ours = await items(locationOf(doi, "", provider), {
        recursive: true,
      });
      const theirs = await rcloneItems(doi, provider);
      // The folders have no time in the lists of the providers.
      const files = (list) => list.filter((item) => !item.IsDir);
      const folders = (list) =>
        list.filter((item) => item.IsDir).map(({ Path }) => Path);
      assert.deepEqual(files(ours), files(theirs));
      assert.deepEqual(folders(ours), folders(theirs));
      for (const { Path } of files(theirs)) {
        const remote = `:doi,doi='${doi}',doi_resolver_api_url='${resolver}'${
          provider ? `,provider=${provider}` : ""
        }:${Path}`;
        const { stdout } = await rclone("cat", remote);
        const response = await fetch(locationOf(doi, Path, provider));
        assert.equal(await response.text(), stdout, Path);
      }
    });
  }
});
