/**
 * The tests of the tiles backend against go-pmtiles, the tool of Protomaps:
 * rfetch reads the files that go-pmtiles writes from MBTiles files, as
 * `go-pmtiles serve` reads them, and go-pmtiles verify accepts the files of
 * the writer of the tests. The tests run when go-pmtiles is in the PATH, or
 * when PMTILES is its path. They need node:sqlite to write the MBTiles
 * files.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

// Sets the global `fetch` that reads the paths of remotes.
import { fetch as rfetch, lsjson } from "../../mod.js";
import { COMPRESSIONS, pmtilesFile } from "./testing.js";

const PMTILES = process.env.PMTILES || "go-pmtiles";
const hasPMTiles = spawnSync(PMTILES, ["version"]).status === 0;
const sqlite = await import("node:sqlite").catch(() => null);

/**
 * Runs go-pmtiles.
 * @param {string[]} args
 */
function goPMTiles(...args) {
  return spawnSync(PMTILES, args, { encoding: "utf8" });
}

/**
 * Writes an MBTiles file.
 * @param {string} path
 * @param {Record<string, string>} metadata
 * @param {Array<{ z: number, x: number, y: number, data: Uint8Array }>} tiles
 */
function mbtiles(path, metadata, tiles) {
  const db = new (/** @type {any} */ (sqlite).DatabaseSync)(path);
  db.exec("CREATE TABLE metadata (name text, value text)");
  db.exec(
    "CREATE TABLE tiles (zoom_level integer, tile_column integer, " +
      "tile_row integer, tile_data blob)",
  );
  const meta = db.prepare("INSERT INTO metadata VALUES (?, ?)");
  for (const [name, value] of Object.entries(metadata)) meta.run(name, value);
  // The index of the specification of MBTiles: go-pmtiles reads each
  // tile with it.
  db.exec(
    "CREATE UNIQUE INDEX tile_index ON tiles " +
      "(zoom_level, tile_column, tile_row)",
  );
  const insert = db.prepare("INSERT INTO tiles VALUES (?, ?, ?, ?)");
  db.exec("BEGIN");
  for (const { z, x, y, data } of tiles) {
    // MBTiles counts the rows from the south.
    insert.run(z, x, 2 ** z - 1 - y, data);
  }
  db.exec("COMMIT");
  db.close();
}

/** A free port of the local machine. */
function freePort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (
        server.address()
      );
      server.close(() => resolve(port));
    });
  });
}

describe("tiles and go-pmtiles", {
  skip: (!hasPMTiles &&
    "go-pmtiles is not installed. Set PMTILES to the path of go-pmtiles.") ||
    (!sqlite && "node:sqlite is not in this Node.js."),
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-pmtiles-"));
  after(() => rmSync(folder, { recursive: true, force: true }));

  test("go-pmtiles verify accepts the files of the writer of the tests", () => {
    const tiles = [];
    for (let z = 0; z <= 5; z++) {
      for (let x = 0; x < 2 ** z; x++) {
        for (let y = 0; y < 2 ** z; y++) {
          tiles.push({ z, x, y, data: (x + y) % 3 ? `${z}/${x}/${y}` : "sea" });
        }
      }
    }
    for (
      const [name, options] of [
        ["plain", {}],
        ["leaves", { leafSize: 50 }],
        ["two-levels", { leafSize: 7, levels: 2 }],
        ["none", {
          tileType: 2,
          tileCompression: COMPRESSIONS.none,
          internalCompression: COMPRESSIONS.none,
        }],
        ["brotli", { tileCompression: COMPRESSIONS.brotli }],
      ]
    ) {
      const path = join(folder, `writer-${name}.pmtiles`);
      writeFileSync(path, pmtilesFile(tiles, options));
      const result = goPMTiles("verify", path);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
  });

  /**
   * The files of go-pmtiles: vector tiles in gzip with tiles that are the
   * same and tiles that are not in the file, tiles with no compression in
   * leaf directories, and PNG tiles with no compression. The tiles of
   * random sizes make a root directory of more than 16 KiB: thus
   * go-pmtiles writes leaf directories.
   * @type {Array<{ name: string, format: string, max: number, has: (z: number, x: number, y: number) => boolean, data: (z: number, x: number, y: number) => Uint8Array }>}
   */
  const files = [
    {
      name: "vector",
      format: "pbf",
      max: 5,
      has: (z, x, y) => !(z === 5 && (x * y) % 3 === 1),
      data: (z, x, y) =>
        gzipSync((x + y) % 4 === 0 ? "sea" : `tile ${z}/${x}/${y}`),
    },
    {
      name: "leaves",
      format: "png",
      max: 7,
      has: () => true,
      data: () => randomBytes(1 + randomBytes(1)[0]),
    },
    {
      name: "raster",
      format: "png",
      max: 3,
      has: (z, x) => x % 2 === 0 || z < 2,
      data: (z, x, y) => new TextEncoder().encode(`png ${z}/${x}/${y}`),
    },
  ];
  for (const file of files) {
    const tiles = [];
    for (let z = 0; z <= file.max; z++) {
      for (let x = 0; x < 2 ** z; x++) {
        for (let y = 0; y < 2 ** z; y++) {
          if (file.has(z, x, y)) {
            tiles.push({ z, x, y, data: file.data(z, x, y) });
          }
        }
      }
    }
    const path = join(folder, file.name);
    mbtiles(`${path}.mbtiles`, {
      name: file.name,
      format: file.format,
      minzoom: "0",
      maxzoom: `${file.max}`,
      bounds: "-180,-85,180,85",
      center: "0,0,0",
      json: JSON.stringify({ vector_layers: [{ id: "a", fields: {} }] }),
    }, tiles);
    const done = goPMTiles("convert", `${path}.mbtiles`, `${path}.pmtiles`);
    assert.equal(done.status, 0, done.stderr);
  }
  // The file "leaves" has leaf directories: the length of their part of the
  // file, in the header.
  const header = readFileSync(join(folder, "leaves.pmtiles")).subarray(0, 127);
  assert.ok(
    new DataView(header.buffer, header.byteOffset).getBigUint64(48, true) > 0n,
    "go-pmtiles wrote no leaf directory",
  );

  test("rfetch reads the tiles and the metadata as go-pmtiles serve", async () => {
    const port = await freePort();
    const server = spawn(PMTILES, [
      "serve",
      folder,
      "--interface=127.0.0.1",
      `--port=${port}`,
    ], { stdio: "ignore" });
    try {
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 100; i++) {
        try {
          await (await fetch(`${base}/vector/metadata`)).body?.cancel();
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      for (const file of files) {
        const ours = `:tiles:${folder}/${file.name}.pmtiles/`;
        const metadata = await (await rfetch(`${ours}metadata.json`)).json();
        assert.deepEqual(
          metadata,
          await (await fetch(`${base}/${file.name}/metadata`)).json(),
          file.name,
        );
        const extension = file.format === "png" ? "png" : "mvt";
        for (let z = 0; z <= file.max; z++) {
          // All the tiles of the small zoom levels, and a part of the others.
          const step = z < 6 ? 1 : 97;
          for (let index = 0; index < 4 ** z; index += step) {
            const x = index % 2 ** z;
            const y = Math.floor(index / 2 ** z);
            const what = `${file.name} ${z}/${x}/${y}`;
            const theirs = await fetch(
              `${base}/${file.name}/${z}/${x}/${y}.${extension}`,
            );
            const response = await rfetch(`${ours}${z}/${x}/${y}.${extension}`);
            if (!file.has(z, x, y)) {
              // go-pmtiles serve gives 204 or 404 for no tile.
              await theirs.body?.cancel();
              await response.body?.cancel();
              assert.ok([204, 404].includes(theirs.status), what);
              assert.equal(response.status, 404, what);
              continue;
            }
            assert.equal(theirs.status, 200, what);
            assert.equal(response.status, 200, what);
            assert.deepEqual(
              new Uint8Array(await response.arrayBuffer()),
              new Uint8Array(await theirs.arrayBuffer()),
              what,
            );
          }
        }
      }
    } finally {
      server.kill();
    }
  });

  test("rfetch lists the tiles of the files of go-pmtiles", async () => {
    for (const file of files) {
      const extension = file.format === "png" ? ".png" : ".mvt";
      const ours = `:tiles:${folder}/${file.name}.pmtiles/`;
      const root = await (await lsjson(ours)).json();
      assert.deepEqual(
        root.map(({ Name }) => Name),
        [...Array(file.max + 1).keys()].map(String).concat("metadata.json"),
        file.name,
      );
      for (const z of [0, Math.min(file.max, 5)]) {
        const columns = await (await lsjson(`${ours}${z}/`)).json();
        const expected = [...Array(2 ** z).keys()].filter((x) =>
          [...Array(2 ** z).keys()].some((y) => file.has(z, x, y))
        );
        // lsjson gives the names in the order of the text, as rclone.
        assert.deepEqual(
          columns.map(({ Name }) => Number(Name)).sort((a, b) => a - b),
          expected,
          `${file.name} ${z}/`,
        );
        const x = expected.at(-1) ?? 0;
        const rows = await (await lsjson(`${ours}${z}/${x}/`)).json();
        assert.deepEqual(
          rows.map(({ Name }) => Name).sort(),
          [...Array(2 ** z).keys()].filter((y) => file.has(z, x, y)).map((y) =>
            `${y}${extension}`
          ).sort(),
          `${file.name} ${z}/${x}/`,
        );
      }
    }
  });
});
