/**
 * The tests of the reader of VersaTiles files, on the files of the writer
 * of the tests and on a file of the tool versatiles in testdata. The tests
 * against the tool are in versatiles_rs_test.js.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as zlib from "node:zlib";

// Sets the global `fetch` that reads the paths of remotes.
import { fetch, lsjson } from "../../mod.js";

import { decoder, decompress, TilesError } from "./tileset.js";
import {
  allTiles,
  hasZstd,
  VERSATILES_COMPRESSIONS,
  versatilesFile,
} from "./testing.js";

const text = new TextDecoder();

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

/**
 * A copy of a file with another block index, at the end of the file.
 * @param {Uint8Array} file
 * @param {Uint8Array} index The block index, before the compression.
 * @param {(bytes: Uint8Array) => Uint8Array} [compress]
 */
function withBlockIndex(file, index, compress = zlib.brotliCompressSync) {
  const bytes = new Uint8Array(compress(index));
  const result = new Uint8Array(file.length + bytes.length);
  result.set(file);
  result.set(bytes, file.length);
  const view = new DataView(result.buffer);
  view.setBigUint64(50, BigInt(file.length));
  view.setBigUint64(58, BigInt(bytes.length));
  return result;
}

/**
 * The block index of a file, after decompression.
 * @param {Uint8Array} file
 */
function blockIndexOf(file) {
  const view = new DataView(file.buffer, file.byteOffset, file.length);
  const offset = Number(view.getBigUint64(50));
  const length = Number(view.getBigUint64(58));
  return new Uint8Array(
    zlib.brotliDecompressSync(file.subarray(offset, offset + length)),
  );
}

test("a VersaTiles file is a folder, and the other files are files of the remote", async () => {
  await put("/vt-remote/a.versatiles", versatilesFile(allTiles(1)));
  await put("/vt-remote/b.txt", new TextEncoder().encode("b"));
  const response = await lsjson(":tiles::memory:/vt-remote/");
  assert.deepEqual(
    (await response.json()).map(({ Name, IsDir, Size }) => [Name, IsDir, Size]),
    [["a.versatiles", true, -1], ["b.txt", false, 1]],
  );
  assert.deepEqual(await names(":tiles::memory:/vt-remote/a.versatiles/"), [
    "0",
    "1",
    "metadata.json",
  ]);
  // A file with no "/" after its name is the file of the remote.
  const file = await fetch(":tiles::memory:/vt-remote/a.versatiles");
  assert.equal(
    text.decode((await file.arrayBuffer()).slice(0, 14)),
    "versatiles_v02",
  );
});

test("reads the tiles of each compression", async () => {
  const files = [
    ["none", VERSATILES_COMPRESSIONS.none, null, null],
    ["gzip", VERSATILES_COMPRESSIONS.gzip, "gzip", zlib.gunzipSync],
    ["brotli", VERSATILES_COMPRESSIONS.brotli, "br", zlib.brotliDecompressSync],
  ];
  if (hasZstd) {
    files.push([
      "zstd",
      VERSATILES_COMPRESSIONS.zstd,
      "zstd",
      zlib.zstdDecompressSync,
    ]);
  }
  for (const [name, compression, coding, decode] of files) {
    await put(
      `/vt-codings/${name}.versatiles`,
      versatilesFile(allTiles(2), { compression }),
    );
    const path = `:tiles::memory:/vt-codings/${name}.versatiles/2/3/1.mvt`;
    const response = await fetch(path);
    assert.equal(response.status, 200, name);
    assert.equal(
      response.headers.get("Content-Type"),
      "application/vnd.mapbox-vector-tile",
    );
    assert.equal(response.headers.get("Content-Encoding"), null, name);
    assert.equal(await response.text(), "tile 2/3/1", name);
    if (coding) {
      assert.equal(response.headers.get("Accept-Ranges"), "none", name);
      // The stored bytes, for a client that decodes them.
      const stored = await fetch(path, {
        headers: { "Accept-Encoding": "gzip, br, zstd" },
      });
      assert.equal(stored.headers.get("Content-Encoding"), coding, name);
      assert.equal(stored.headers.get("Vary"), "Accept-Encoding");
      const bytes = new Uint8Array(await stored.arrayBuffer());
      assert.equal(stored.headers.get("Content-Length"), `${bytes.length}`);
      assert.equal(
        text.decode(/** @type {Function} */ (decode)(bytes)),
        "tile 2/3/1",
      );
    } else {
      assert.equal(response.headers.get("Content-Length"), "10");
      const part = await fetch(path, { headers: { Range: "bytes=5-" } });
      assert.equal(part.status, 206);
      assert.equal(await part.text(), "2/3/1");
    }
  }
});

test("finds each tile in the blocks of a zoom level", async () => {
  // Tiles in blocks of 256 × 256 tiles: 4 blocks at the zoom level 9, and
  // 16 at the zoom level 10.
  const places = [
    [9, 0, 0],
    [9, 255, 255],
    [9, 256, 0],
    [9, 300, 5],
    [9, 511, 511],
    [9, 10, 400],
    [10, 1023, 0],
    [10, 512, 512],
    [10, 600, 700],
  ];
  await put(
    "/vt-blocks/a.versatiles",
    versatilesFile(
      places.map(([z, x, y]) => ({
        z,
        x,
        y,
        data: x === 300 ? "sea" : `tile ${z}/${x}/${y}`,
      })).concat({ z: 9, x: 301, y: 6, data: "sea" }),
    ),
  );
  const base = ":tiles::memory:/vt-blocks/a.versatiles/";
  for (const [z, x, y] of places) {
    const response = await fetch(`${base}${z}/${x}/${y}.mvt`);
    assert.equal(response.status, 200, `${z}/${x}/${y}`);
    assert.equal(
      await response.text(),
      x === 300 ? "sea" : `tile ${z}/${x}/${y}`,
    );
  }
  for (
    const place of [
      // In the rectangle of a block, with no tile.
      "9/1/1",
      "9/257/1",
      // Out of the rectangle of a block.
      "9/400/100",
      // No block.
      "10/0/0",
    ]
  ) {
    const response = await fetch(`${base}${place}.mvt`);
    await response.body?.cancel();
    assert.equal(response.status, 404, place);
  }
  // lsjson gives the names in the order of the text, as rclone.
  assert.deepEqual(await names(base), ["10", "9", "metadata.json"]);
  assert.deepEqual(
    (await names(`${base}9/`)).map(Number).sort((a, b) => a - b),
    [0, 10, 255, 256, 300, 301, 511],
  );
  assert.deepEqual(await names(`${base}9/300/`), ["5.mvt"]);
  assert.deepEqual(
    (await names(`${base}10/`)).map(Number).sort((a, b) => a - b),
    [512, 600, 1023],
  );
});

test("reads the metadata, and a file with no metadata has no metadata.json", async () => {
  const metadata = { name: "été", vector_layers: [{ id: "roads" }] };
  await put("/vt-meta/a.versatiles", versatilesFile(allTiles(0), { metadata }));
  const path = ":tiles::memory:/vt-meta/a.versatiles/metadata.json";
  const response = await fetch(path);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await response.json(), metadata);
  const part = await fetch(path, { headers: { Range: "bytes=0-6" } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), '{"name"');

  await put(
    "/vt-meta/none.versatiles",
    versatilesFile(allTiles(0), { metadata: null }),
  );
  assert.deepEqual(await names(":tiles::memory:/vt-meta/none.versatiles/"), [
    "0",
  ]);
  const none = await fetch(
    ":tiles::memory:/vt-meta/none.versatiles/metadata.json",
  );
  assert.equal(none.status, 404);
  assert.equal(await none.text(), "object not found");
});

test("gives each type of tile its extension and its media type", async () => {
  for (
    const [format, name, mime] of [
      [0x10, "a.png", "image/png"],
      [0x11, "a.jpg", "image/jpeg"],
      [0x12, "a.webp", "image/webp"],
      [0x13, "a.avif", "image/avif"],
      [0x14, "a.svg", "image/svg+xml"],
      [0x21, "a.geojson", "application/geo+json"],
      [0x22, "a.topojson", "application/topo+json"],
      [0x23, "a.json", "application/json"],
      [0x00, "a", "application/octet-stream"],
    ]
  ) {
    await put(
      `/vt-types/${format}.versatiles`,
      versatilesFile([{ z: 0, x: 0, y: 0, data: "tile" }], {
        tileFormat: format,
        compression: VERSATILES_COMPRESSIONS.none,
      }),
    );
    const base = `:tiles::memory:/vt-types/${format}.versatiles/0/0/`;
    assert.deepEqual(
      await names(base),
      [name.replace("a", "0")],
      `${format}`,
    );
    const response = await fetch(`${base}${name.replace("a", "0")}`);
    assert.equal(response.headers.get("Content-Type"), mime);
    assert.equal(await response.text(), "tile");
  }
});

test("gives 501 for a list that needs too many blocks, or that has too many tiles", async () => {
  // 33 blocks at the zoom level 13: 32 on the first row of blocks.
  const tiles = [];
  for (let column = 0; column < 32; column++) {
    tiles.push({ z: 13, x: column * 256, y: 0, data: `${column}` });
  }
  tiles.push({ z: 13, x: 0, y: 256, data: "second row" });
  await put("/vt-large/blocks.versatiles", versatilesFile(tiles));
  const base = ":tiles::memory:/vt-large/blocks.versatiles/";
  const zoom = await lsjson(`${base}13/`);
  assert.equal(zoom.status, 501);
  assert.equal(
    await zoom.text(),
    "versatiles: the request needs too many blocks",
  );
  // A column reads only the blocks of its column.
  assert.deepEqual(await names(`${base}13/0/`), ["0.mvt", "256.mvt"]);

  // Two full blocks: 131072 tiles.
  const sea = [];
  for (let x = 0; x < 512; x++) {
    for (let y = 0; y < 256; y++) sea.push({ z: 9, x, y, data: "sea" });
  }
  await put(
    "/vt-large/sea.versatiles",
    versatilesFile(sea, { compression: VERSATILES_COMPRESSIONS.none }),
  );
  const run = await lsjson(":tiles::memory:/vt-large/sea.versatiles/9/");
  assert.equal(run.status, 501);
  assert.equal(
    await run.text(),
    "versatiles: the list has more than 100000 tiles",
  );
  const tile = await fetch(
    ":tiles::memory:/vt-large/sea.versatiles/9/511/255.mvt",
  );
  assert.equal(await tile.text(), "sea");
});

test("gives 501 for the values that the specification reserves, and 500 for a file that is not correct", async () => {
  const good = versatilesFile(allTiles(1));
  /**
   * A copy of the good file, with bytes at a place.
   * @param {number} offset
   * @param {number[]} bytes
   */
  const patched = (offset, bytes) => {
    const file = good.slice();
    file.set(bytes, offset);
    return file;
  };
  const index = blockIndexOf(good);
  // The block of the zoom level 1: its entry in the block index.
  const entry =
    [...Array(index.length / 33).keys()].find((at) => index[at * 33] === 1) *
    33;
  /**
   * A copy of the block index, with bytes in the entry of the zoom level 1.
   * @param {number} offset
   * @param {number[]} bytes
   */
  const indexWith = (offset, bytes) => {
    const copy = index.slice();
    copy.set(bytes, entry + offset);
    return withBlockIndex(good, copy);
  };
  // The block of the zoom level 1 starts 1 byte before the end of its
  // tiles: its tile index stays at its place, and the tiles go out of the
  // block.
  const outside = index.slice();
  const view = new DataView(outside.buffer);
  const tilesLength = view.getBigUint64(entry + 21);
  view.setBigUint64(
    entry + 13,
    view.getBigUint64(entry + 13) + tilesLength - 1n,
  );
  view.setBigUint64(entry + 21, 1n);
  const files = {
    "v01": patched(12, [0x30, 0x31]),
    "format": patched(14, [0x30]),
    "compression": patched(15, [9]),
    "text": new TextEncoder().encode("not a file of tiles"),
    "short": good.slice(0, 40),
    "cut": good.slice(0, good.length - 10),
    "garbage": withBlockIndex(
      good,
      new Uint8Array([1, 2, 3]),
      (bytes) => bytes,
    ),
    "length": withBlockIndex(good, new Uint8Array(34)),
    "bounds": indexWith(9, [1, 0, 0, 0]),
    "level": indexWith(0, [31]),
    // One column of 2 tiles, and a tile index of 4 tiles.
    "count": indexWith(11, [0]),
    "outside": withBlockIndex(good, outside),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await put(`/vt-bad/${name}.versatiles`, bytes);
  }
  for (
    const [path, status, message] of [
      ["v01.versatiles/", 501, "versatiles: the version 01 is not supported"],
      [
        "format.versatiles/",
        501,
        "versatiles: the tile format 48 is not supported",
      ],
      [
        "compression.versatiles/",
        501,
        "versatiles: the compression 9 is not supported",
      ],
      ["text.versatiles/", 500, "versatiles: not a VersaTiles file"],
      ["short.versatiles/", 500, "versatiles: the header is not complete"],
      [
        "cut.versatiles/",
        500,
        "versatiles: the block index is out of the file",
      ],
      [
        "garbage.versatiles/",
        500,
        "versatiles: the block index is not correct compressed data",
      ],
      [
        "length.versatiles/",
        500,
        "versatiles: the length of the block index is not correct",
      ],
      [
        "bounds.versatiles/",
        500,
        "versatiles: a block of the block index is not correct",
      ],
      [
        "level.versatiles/",
        500,
        "versatiles: a block of the block index is not correct",
      ],
      [
        "count.versatiles/1/0/0.mvt",
        500,
        "versatiles: a tile index does not have the tiles of its block",
      ],
      [
        "outside.versatiles/1/1/1.mvt",
        500,
        "versatiles: a tile is out of its block",
      ],
    ]
  ) {
    const response = await fetch(`:tiles::memory:/vt-bad/${path}`);
    assert.equal(response.status, status, path);
    assert.equal(await response.text(), message, path);
  }
});

test("decodes brotli and zstd with node:zlib when DecompressionStream does not have them, as in a Worker", async () => {
  const Original = globalThis.DecompressionStream;
  // The DecompressionStream of a Worker of Cloudflare.
  globalThis.DecompressionStream = class extends Original {
    /** @param {CompressionFormat} format */
    constructor(format) {
      if (!["gzip", "deflate", "deflate-raw"].includes(format)) {
        throw new TypeError(`The compression format ${format} is not known`);
      }
      super(format);
    }
  };
  try {
    await put(
      "/vt-worker/a.versatiles",
      versatilesFile(allTiles(2), {
        compression: VERSATILES_COMPRESSIONS.brotli,
        metadata: { name: "worker" },
      }),
    );
    const base = ":tiles::memory:/vt-worker/a.versatiles/";
    assert.equal(
      (await (await fetch(`${base}metadata.json`)).json()).name,
      "worker",
    );
    assert.equal(await (await fetch(`${base}2/1/2.mvt`)).text(), "tile 2/1/2");

    const brotli = zlib.brotliCompressSync("brotli");
    assert.equal(
      text.decode(await decompress(brotli, "br", "test", "the data")),
      "brotli",
    );
    if (hasZstd) {
      const zstd = zlib.zstdCompressSync("zstd");
      assert.equal(
        text.decode(await decompress(zstd, "zstd", "test", "the data")),
        "zstd",
      );
    }
    // A stream of a tile: the decoder keeps the data until their end.
    const stream = /** @type {ReadableWritablePair<Uint8Array, Uint8Array>} */ (
      decoder("br", "test", "the tile")
    );
    assert.ok(!(stream instanceof Original));
    assert.equal(
      await new Response(new Blob([brotli]).stream().pipeThrough(stream))
        .text(),
      "brotli",
    );

    // At most 32 MiB after the decoding.
    const large = zlib.brotliCompressSync(new Uint8Array(33 * 1024 * 1024), {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 },
    });
    await assert.rejects(
      decompress(large, "br", "test", "the data"),
      (/** @type {TilesError} */ error) =>
        error instanceof TilesError && error.status === 501 &&
        error.message === "test: the data has more than 33554432 bytes",
    );
    await assert.rejects(
      decompress(new Uint8Array([1, 2, 3]), "br", "test", "the data"),
      (/** @type {TilesError} */ error) =>
        error instanceof TilesError && error.status === 500 &&
        error.message === "test: the data is not correct compressed data",
    );
  } finally {
    globalThis.DecompressionStream = Original;
  }
});

test("reads the file of the tool versatiles in testdata", async () => {
  // See testdata/README.md.
  await put(
    "/vt-fixture/fixture.versatiles",
    readFileSync(new URL("./testdata/fixture.versatiles", import.meta.url)),
  );
  const base = ":tiles::memory:/vt-fixture/fixture.versatiles/";
  assert.deepEqual(await names(base), ["0", "1", "2", "3", "metadata.json"]);
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
  // The tiles are in brotli: a client that accepts brotli gets them.
  const stored = await fetch(`${base}3/2/4.mvt`, {
    headers: { "Accept-Encoding": "br" },
  });
  assert.equal(stored.headers.get("Content-Encoding"), "br");
  assert.equal(
    text.decode(
      zlib.brotliDecompressSync(new Uint8Array(await stored.arrayBuffer())),
    ),
    "tile 3/2/4",
  );
});
