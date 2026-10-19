import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Sets the global `fetch` that reads the paths of remotes.
import { fetch, lsjson } from "../../mod.js";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { tileId, tileOf } from "./pmtiles.js";
import { accepts } from "./tileset.js";
import { COMPRESSIONS, pmtilesFile } from "./testing.js";

const decoder = new TextDecoder();

/**
 * The tiles of all the zoom levels from 0 up to `max`.
 * @param {number} max
 * @param {(z: number, x: number, y: number) => string} [data]
 */
function allTiles(max, data = (z, x, y) => `tile ${z}/${x}/${y}`) {
  const tiles = [];
  for (let z = 0; z <= max; z++) {
    for (let x = 0; x < 2 ** z; x++) {
      for (let y = 0; y < 2 ** z; y++) {
        tiles.push({ z, x, y, data: data(z, x, y) });
      }
    }
  }
  return tiles;
}

/**
 * Puts a file in the memory backend.
 * @param {string} path
 * @param {Uint8Array} bytes
 */
async function put(path, bytes) {
  const response = await fetch(`:memory:${path}`, {
    method: "PUT",
    body: bytes,
  });
  assert.equal(response.status, 201, path);
}

/** @param {string} path */
async function names(path) {
  const response = await lsjson(path);
  assert.equal(response.status, 200, path);
  return (await response.json()).map(({ Name }) => Name);
}

test("tileId and tileOf give the IDs of go-pmtiles", () => {
  // The values of tile_id_test.go of go-pmtiles.
  for (
    const [z, x, y, id] of [
      [0, 0, 0, 0],
      [1, 0, 0, 1],
      [1, 0, 1, 2],
      [1, 1, 1, 3],
      [1, 1, 0, 4],
      [2, 0, 0, 5],
      [12, 3423, 1763, 19078479],
    ]
  ) {
    assert.equal(tileId(z, x, y), id, `${z}/${x}/${y}`);
    assert.deepEqual(tileOf(id), [z, x, y], `${id}`);
  }
  for (let z = 0; z <= 6; z++) {
    for (let x = 0; x < 2 ** z; x++) {
      for (let y = 0; y < 2 ** z; y++) {
        assert.deepEqual(tileOf(tileId(z, x, y)), [z, x, y]);
      }
    }
  }
  const last = 2 ** 26 - 1;
  for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) {
    assert.deepEqual(tileOf(tileId(26, x, y)), [26, x, y]);
  }
});

test("a PMTiles file is a folder, and the other files are files of the remote", async () => {
  await put("/pm-remote/a.pmtiles", pmtilesFile(allTiles(1)));
  await put("/pm-remote/b.txt", new TextEncoder().encode("b"));
  const response = await lsjson(":tiles::memory:/pm-remote/");
  assert.deepEqual(
    (await response.json()).map(({ Name, IsDir, Size }) => [Name, IsDir, Size]),
    [["a.pmtiles", true, -1], ["b.txt", false, 1]],
  );
  // A file with no "/" after its name is the file of the remote.
  const file = await fetch(":tiles::memory:/pm-remote/a.pmtiles");
  assert.equal(file.status, 200);
  assert.equal(
    decoder.decode((await file.arrayBuffer()).slice(0, 7)),
    "PMTiles",
  );
  const write = await fetch(":tiles::memory:/pm-remote/c.txt", {
    method: "PUT",
    body: "c",
  });
  assert.equal(write.status, 201);
  assert.equal(
    await (await fetch(":memory:/pm-remote/c.txt")).text(),
    "c",
  );
});

test("lists the zoom levels, the columns and the tiles", async () => {
  await put(
    "/pm-list/a.pmtiles",
    pmtilesFile(allTiles(3).filter(({ z, x }) => z < 3 || x % 2 === 0), {
      metadata: { name: "a" },
    }),
  );
  const root = await (await lsjson(":tiles::memory:/pm-list/a.pmtiles/"))
    .json();
  assert.deepEqual(
    root.map((
      { Name, IsDir, Size, MimeType },
    ) => [Name, IsDir, Size, MimeType]),
    [
      ["0", true, -1, "inode/directory"],
      ["1", true, -1, "inode/directory"],
      ["2", true, -1, "inode/directory"],
      ["3", true, -1, "inode/directory"],
      ["metadata.json", false, 12, "application/json"],
    ],
  );
  // The time of each entry is the time of the PMTiles file.
  const [file] = await (await lsjson(":memory:/pm-list/")).json();
  for (const { ModTime } of root) {
    assert.equal(
      Math.floor(Date.parse(ModTime) / 1000),
      Math.floor(Date.parse(file.ModTime) / 1000),
    );
  }
  assert.deepEqual(await names(":tiles::memory:/pm-list/a.pmtiles/3/"), [
    "0",
    "2",
    "4",
    "6",
  ]);
  const tiles = await (await lsjson(":tiles::memory:/pm-list/a.pmtiles/3/4/"))
    .json();
  assert.deepEqual(tiles.map(({ Name }) => Name), [
    "0.mvt",
    "1.mvt",
    "2.mvt",
    "3.mvt",
    "4.mvt",
    "5.mvt",
    "6.mvt",
    "7.mvt",
  ]);
  // A tile in gzip has no size before the decompression.
  assert.deepEqual(
    tiles.map(({ Size, MimeType }) => [Size, MimeType])[0],
    [-1, "application/vnd.mapbox-vector-tile"],
  );
  const deep = await lsjson(":tiles::memory:/pm-list/a.pmtiles/", {
    recursive: true,
  });
  assert.equal((await deep.json()).length, 5 + 1 + 2 + 4 + 4 + 21 + 32);
});

test("reads a tile in gzip or in brotli, with no size and no ranges", async () => {
  for (const compression of [COMPRESSIONS.gzip, COMPRESSIONS.brotli]) {
    await put(
      `/pm-gzip/${compression}.pmtiles`,
      pmtilesFile(allTiles(2), { tileCompression: compression }),
    );
    const path = `:tiles::memory:/pm-gzip/${compression}.pmtiles/2/3/1.mvt`;
    const head = await fetch(path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("Content-Length"), null);
    assert.equal(head.headers.get("Accept-Ranges"), "none");
    assert.ok(head.headers.get("Last-Modified"));
    // The tile is all the data, also for a range.
    const response = await fetch(path, { headers: { Range: "bytes=0-1" } });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Type"),
      "application/vnd.mapbox-vector-tile",
    );
    assert.equal(await response.text(), "tile 2/3/1");
  }
});

test("accepts reads Accept-Encoding as RFC 9110", () => {
  for (
    const [header, encoding, expected] of [
      [null, "gzip", false],
      ["", "gzip", false],
      ["gzip", "gzip", true],
      ["GZIP", "gzip", true],
      ["deflate, gzip;q=0.5, br", "br", true],
      ["gzip;q=0", "gzip", false],
      ["gzip; q=0.000", "gzip", false],
      ["*", "br", true],
      ["*;q=0", "br", false],
      ["gzip;q=0, *", "gzip", false],
      ["identity", "gzip", false],
      ["br", "gzip", false],
    ]
  ) {
    assert.equal(accepts(header, encoding), expected, `${header} ${encoding}`);
  }
});

test("sends the stored bytes of a tile to a client that accepts their encoding", async () => {
  const files = [
    ["gzip", COMPRESSIONS.gzip, gunzipSync],
    ["br", COMPRESSIONS.brotli, brotliDecompressSync],
  ];
  for (const [coding, compression, decode] of files) {
    await put(
      `/pm-stored/${coding}.pmtiles`,
      pmtilesFile(allTiles(2), { tileCompression: compression }),
    );
    const path = `:tiles::memory:/pm-stored/${coding}.pmtiles/2/3/1.mvt`;
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(path, {
        method,
        headers: { "Accept-Encoding": "gzip, deflate, br, zstd" },
      });
      assert.equal(response.status, 200, `${coding} ${method}`);
      assert.equal(response.headers.get("Content-Encoding"), coding);
      assert.equal(response.headers.get("Vary"), "Accept-Encoding");
      assert.equal(
        response.headers.get("Content-Type"),
        "application/vnd.mapbox-vector-tile",
      );
      if (method === "HEAD") {
        assert.equal(response.body, null);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(response.headers.get("Content-Length"), `${bytes.length}`);
      assert.equal(decoder.decode(decode(bytes)), "tile 2/3/1", coding);
    }
  }
  // A request that does not accept the encoding gets the tile.
  for (
    const [coding, header] of [
      ["gzip", "gzip;q=0"],
      ["gzip", "br"],
      ["gzip", "identity"],
      ["br", "gzip"],
    ]
  ) {
    const response = await fetch(
      `:tiles::memory:/pm-stored/${coding}.pmtiles/2/3/1.mvt`,
      { headers: { "Accept-Encoding": header } },
    );
    assert.equal(response.headers.get("Content-Encoding"), null, header);
    assert.equal(response.headers.get("Vary"), "Accept-Encoding");
    assert.equal(await response.text(), "tile 2/3/1", `${coding} ${header}`);
  }
  // A tile with no compression has no encoding.
  await put(
    "/pm-stored/none.pmtiles",
    pmtilesFile(allTiles(1), { tileCompression: COMPRESSIONS.none }),
  );
  const plain = await fetch(
    ":tiles::memory:/pm-stored/none.pmtiles/1/0/1.mvt",
    {
      headers: { "Accept-Encoding": "gzip" },
    },
  );
  assert.equal(plain.headers.get("Content-Encoding"), null);
  assert.equal(await plain.text(), "tile 1/0/1");
});

test("reads a tile with no compression, with its size and ranges", async () => {
  await put(
    "/pm-png/a.pmtiles",
    pmtilesFile(allTiles(2), {
      tileType: 2,
      tileCompression: COMPRESSIONS.none,
      internalCompression: COMPRESSIONS.none,
    }),
  );
  const path = ":tiles::memory:/pm-png/a.pmtiles/2/1/3.png";
  const response = await fetch(path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("Content-Length"), "10");
  assert.equal(await response.text(), "tile 2/1/3");
  const part = await fetch(path, { headers: { Range: "bytes=5-" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("Content-Range"), "bytes 5-9/10");
  assert.equal(await part.text(), "2/1/3");
  const outside = await fetch(path, { headers: { Range: "bytes=10-" } });
  await outside.body?.cancel();
  assert.equal(outside.status, 416);
  const list = await (await lsjson(":tiles::memory:/pm-png/a.pmtiles/2/1/"))
    .json();
  assert.deepEqual(list.map(({ Name, Size }) => [Name, Size])[3], [
    "3.png",
    10,
  ]);
});

test("reads the metadata", async () => {
  const metadata = { name: "été", vector_layers: [{ id: "roads" }] };
  await put("/pm-meta/a.pmtiles", pmtilesFile(allTiles(0), { metadata }));
  const path = ":tiles::memory:/pm-meta/a.pmtiles/metadata.json";
  const response = await fetch(path);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await response.json(), metadata);
  const part = await fetch(path, { headers: { Range: "bytes=0-6" } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), '{"name"');
});

test("reads each tile through two levels of leaf directories", async () => {
  // The same data for some tiles: runs of tiles in one entry.
  const tiles = allTiles(
    4,
    (z, x, y) => (x + y) % 3 ? `tile ${z}/${x}/${y}` : "sea",
  );
  await put(
    "/pm-leaves/a.pmtiles",
    pmtilesFile(tiles, { leafSize: 6, levels: 2 }),
  );
  for (const { z, x, y, data } of tiles) {
    const response = await fetch(
      `:tiles::memory:/pm-leaves/a.pmtiles/${z}/${x}/${y}.mvt`,
    );
    assert.equal(response.status, 200, `${z}/${x}/${y}`);
    assert.equal(await response.text(), data);
  }
  assert.equal(
    (await names(":tiles::memory:/pm-leaves/a.pmtiles/2/")).length,
    4,
  );
});

test("gives 404 for a path that is not a tile of the file", async () => {
  // The zoom levels 1 and 3, and half of the tiles of the zoom level 3.
  await put(
    "/pm-404/a.pmtiles",
    pmtilesFile(
      allTiles(3).filter(({ z, x, y }) =>
        z === 1 || (z === 3 && (x + y) % 2 === 0)
      ),
    ),
  );
  for (
    const [path, status] of [
      ["1/0/0.mvt", 200],
      ["3/1/1.mvt", 200],
      // No tile, or a zoom level that the file does not have.
      ["3/1/2.mvt", 404],
      ["2/0/0.mvt", 404],
      ["0/0/0.mvt", 404],
      ["4/0/0.mvt", 404],
      // Not the name of a tile.
      ["3/01/1.mvt", 404],
      ["3/1/1.png", 404],
      ["3/1/1", 404],
      ["3/8/0.mvt", 404],
      ["3/0/8.mvt", 404],
      ["3/-1/0.mvt", 404],
      ["3/1", 404],
      ["3", 404],
      ["metadata", 404],
      ["x.mvt", 404],
      ["3/1/1/0.mvt", 404],
      ["27/0/0.mvt", 404],
      // Not the name of a folder.
      ["3/1/1.mvt/", 404],
      ["metadata.json/", 404],
      ["0/", 404],
      ["4/", 404],
      ["3/9/", 404],
      ["x/", 404],
      ["3/x/", 404],
      // A zoom level between the lowest and the highest, with no tile.
      ["2/", 200],
      ["3/1/", 200],
    ]
  ) {
    const response = await fetch(`:tiles::memory:/pm-404/a.pmtiles/${path}`);
    await response.body?.cancel();
    assert.equal(response.status, status, path);
  }
  assert.deepEqual(await names(":tiles::memory:/pm-404/a.pmtiles/2/"), []);
  const missing = await fetch(":tiles::memory:/pm-404/b.pmtiles/1/0/0.mvt");
  await missing.body?.cancel();
  assert.equal(missing.status, 404);
});

test("is read only in a PMTiles file", async () => {
  await put("/pm-ro/a.pmtiles", pmtilesFile(allTiles(1)));
  for (const method of ["PUT", "DELETE"]) {
    for (const path of ["1/0/0.mvt", "2/0/0.mvt", "metadata.json", "1/"]) {
      const response = await fetch(
        `:tiles::memory:/pm-ro/a.pmtiles/${path}`,
        {
          method,
          body: method === "PUT" ? "x" : undefined,
        },
      );
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(await response.text(), "read only file system");
    }
  }
});

test("gives 501 for a list that is too large", async () => {
  // One entry for all the 262144 tiles of the zoom level 9.
  const sea = [];
  for (let x = 0; x < 512; x++) {
    for (let y = 0; y < 512; y++) sea.push({ z: 9, x, y, data: "sea" });
  }
  await put(
    "/pm-large/run.pmtiles",
    pmtilesFile(sea, { tileCompression: COMPRESSIONS.none }),
  );
  const run = await lsjson(":tiles::memory:/pm-large/run.pmtiles/9/");
  assert.equal(run.status, 501);
  assert.equal(
    await run.text(),
    "pmtiles: the list has more than 100000 tiles",
  );
  // The tile is one read, also in a large run.
  const tile = await fetch(
    ":tiles::memory:/pm-large/run.pmtiles/9/511/3.mvt",
  );
  assert.equal(await tile.text(), "sea");

  // A leaf directory for each tile: a list reads at most 32.
  await put(
    "/pm-large/leaves.pmtiles",
    pmtilesFile(allTiles(3), { leafSize: 1 }),
  );
  const leaves = await lsjson(":tiles::memory:/pm-large/leaves.pmtiles/3/");
  assert.equal(leaves.status, 501);
  assert.equal(
    await leaves.text(),
    "pmtiles: the request needs too many leaf directories",
  );
  assert.equal(
    (await names(":tiles::memory:/pm-large/leaves.pmtiles/2/")).length,
    4,
  );
});

test("gives 501 for what rfetch does not read, and 500 for a file that is not correct", async () => {
  await put("/pm-bad/v2.pmtiles", pmtilesFile(allTiles(0), { version: 2 }));
  // A compression that the specification does not know.
  await put(
    "/pm-bad/other.pmtiles",
    pmtilesFile(allTiles(0), { tileCompression: 9 }),
  );
  await put("/pm-bad/text.pmtiles", new TextEncoder().encode("not PMTiles"));
  const cut = pmtilesFile(allTiles(2));
  await put("/pm-bad/cut.pmtiles", cut.slice(0, 130));
  for (
    const [path, status, text] of [
      ["v2.pmtiles/0/0/0.mvt", 501, "pmtiles: the version 2 is not supported"],
      [
        "other.pmtiles/0/0/0.mvt",
        501,
        "pmtiles: the compression 9 of the tiles is not supported",
      ],
      ["text.pmtiles/", 500, "pmtiles: not a PMTiles file"],
      ["cut.pmtiles/", 500, "pmtiles: the root directory is out of the file"],
    ]
  ) {
    const response = await fetch(`:tiles::memory:/pm-bad/${path}`);
    assert.equal(response.status, status, path);
    assert.equal(await response.text(), text, path);
  }
  // A coding that is not known does not go to a client, also for "*".
  const any = await fetch(":tiles::memory:/pm-bad/other.pmtiles/0/0/0.mvt", {
    headers: { "Accept-Encoding": "*" },
  });
  assert.equal(any.status, 501);
  await any.body?.cancel();
});

test("the option remote tells the remote", async () => {
  await put("/pm-option/maps/a.pmtiles", pmtilesFile(allTiles(1)));
  const response = await fetch(":tiles:maps/a.pmtiles/1/1/0.mvt", {
    headers: { RFETCH_TILES_REMOTE: ":memory:/pm-option" },
  });
  assert.equal(await response.text(), "tile 1/1/0");
});

test("reads the file of go-pmtiles in testdata", async () => {
  // See testdata/README.md.
  await put(
    "/pm-fixture/fixture.pmtiles",
    readFileSync(new URL("./testdata/fixture.pmtiles", import.meta.url)),
  );
  const base = ":tiles::memory:/pm-fixture/fixture.pmtiles/";
  const metadata = await (await fetch(`${base}metadata.json`)).json();
  assert.equal(metadata.name, "fixture");
  for (let z = 0; z <= 3; z++) {
    for (let x = 0; x < 2 ** z; x++) {
      for (let y = 0; y < 2 ** z; y++) {
        const response = await fetch(`${base}${z}/${x}/${y}.mvt`);
        if (z === 3 && (x * y) % 3 === 1) {
          // Not in the file.
          await response.body?.cancel();
          assert.equal(response.status, 404, `${z}/${x}/${y}`);
          continue;
        }
        assert.equal(
          await response.text(),
          (x + y) % 4 === 0 ? "sea" : `tile ${z}/${x}/${y}`,
          `${z}/${x}/${y}`,
        );
      }
    }
  }
});
