/**
 * The tests of the tiles backend against versatiles, the tool of
 * VersaTiles (versatiles-rs): rfetch reads the files that versatiles writes
 * from a folder of tiles, with each compression, and versatiles reads the
 * files of the writer of the tests. The tests run when versatiles is in the
 * PATH, or when VERSATILES is its path.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import * as zlib from "node:zlib";

// Sets the global `fetch` that reads the paths of remotes.
import { fetch as rfetch, lsjson } from "../../mod.js";
import {
  hasZstd,
  pmtilesFile,
  VERSATILES_COMPRESSIONS,
  versatilesFile,
} from "./testing.js";

const VERSATILES = process.env.VERSATILES || "versatiles";
const hasVersaTiles = spawnSync(VERSATILES, ["--version"]).status === 0;

const encoder = new TextEncoder();

/**
 * Runs versatiles.
 * @param {string[]} args
 */
function versatiles(...args) {
  return spawnSync(VERSATILES, ["--quiet", ...args], { encoding: "utf8" });
}

/**
 * The tiles of the files: the tiles of the zoom levels 0 to 4, with no tile
 * at some places of the zoom level 4, and tiles in 4 blocks of the zoom
 * level 9. The tiles `sea` have the same data.
 * @type {Array<{ z: number, x: number, y: number, data: Uint8Array }>}
 */
const tiles = [];
for (let z = 0; z <= 4; z++) {
  for (let x = 0; x < 2 ** z; x++) {
    for (let y = 0; y < 2 ** z; y++) {
      if (z === 4 && (x * y) % 3 === 1) continue;
      const data = (x + y) % 4 === 0 ? "sea" : `tile ${z}/${x}/${y}`;
      tiles.push({ z, x, y, data: encoder.encode(data) });
    }
  }
}
for (const [x, y] of [[0, 0], [255, 255], [256, 0], [300, 5], [511, 511]]) {
  tiles.push({ z: 9, x, y, data: encoder.encode(`tile 9/${x}/${y}`) });
}

/** Places with no tile, in the zoom levels of the files. */
const missing = ["4/1/1", "4/4/7", "9/1/1", "9/257/1", "9/400/100", "9/0/300"];

/** The decoders of the extensions of the files of versatiles. */
const DECODERS = {
  "": (/** @type {Uint8Array} */ bytes) => bytes,
  ".gz": zlib.gunzipSync,
  ".br": zlib.brotliDecompressSync,
  ".zst": zlib.zstdDecompressSync,
};

/**
 * The compressions of versatiles, with their numbers in the header, their
 * content codings and the extensions of their files. zstd needs Node.js
 * 22.15 or later.
 */
const COMPRESSIONS = [
  ["uncompressed", VERSATILES_COMPRESSIONS.none, "identity", ""],
  ["gzip", VERSATILES_COMPRESSIONS.gzip, "gzip", ".gz"],
  ["brotli", VERSATILES_COMPRESSIONS.brotli, "br", ".br"],
  ...(hasZstd ? [["zstd", VERSATILES_COMPRESSIONS.zstd, "zstd", ".zst"]] : []),
];

/**
 * Reads the tiles of a folder that versatiles writes: `Z/X/Y.EXT` and a
 * compression.
 * @param {string} folder
 */
function readFolder(folder) {
  /** @type {Map<string, Uint8Array>} */
  const found = new Map();
  for (const z of readdirSync(folder)) {
    if (!/^\d+$/.test(z)) continue;
    for (const x of readdirSync(join(folder, z))) {
      for (const name of readdirSync(join(folder, z, x))) {
        const [, y, compression] = /** @type {RegExpExecArray} */ (
          /^(\d+)\.pbf(\.gz|\.br|\.zst)?$/.exec(name)
        );
        const decode =
          DECODERS[/** @type {keyof DECODERS} */ (compression ?? "")];
        found.set(
          `${z}/${x}/${y}`,
          new Uint8Array(decode(readFileSync(join(folder, z, x, name)))),
        );
      }
    }
  }
  return found;
}

describe("tiles and versatiles", {
  skip: !hasVersaTiles &&
    "versatiles is not installed. Set VERSATILES to the path of versatiles.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-versatiles-"));
  after(() => rmSync(folder, { recursive: true, force: true }));

  // A folder of vector tiles with no compression, and its metadata.
  const source = join(folder, "source");
  for (const { z, x, y, data } of tiles) {
    mkdirSync(join(source, `${z}`, `${x}`), { recursive: true });
    writeFileSync(join(source, `${z}`, `${x}`, `${y}.pbf`), data);
  }
  writeFileSync(
    join(source, "meta.json"),
    JSON.stringify({
      name: "source",
      vector_layers: [{ id: "a", fields: {} }],
    }),
  );
  // A folder of raster tiles: versatiles does not read their data.
  const raster = join(folder, "raster");
  for (const { z, x, y } of tiles.filter(({ z }) => z <= 2)) {
    mkdirSync(join(raster, `${z}`, `${x}`), { recursive: true });
    writeFileSync(
      join(raster, `${z}`, `${x}`, `${y}.png`),
      `png ${z}/${x}/${y}`,
    );
  }
  for (const [name] of COMPRESSIONS) {
    const done = versatiles(
      "convert",
      "--compress",
      `${name}`,
      source,
      join(folder, `${name}.versatiles`),
    );
    assert.equal(done.status, 0, done.stderr);
  }
  const done = versatiles("convert", raster, join(folder, "raster.versatiles"));
  assert.equal(done.status, 0, done.stderr);

  test("rfetch reads the tiles and the metadata of the files of versatiles", async () => {
    for (const [name, , coding] of COMPRESSIONS) {
      const base = `:tiles:${folder}/${name}.versatiles/`;
      const metadata = await (await rfetch(`${base}metadata.json`)).json();
      assert.equal(metadata.name, "source", name);
      for (const { z, x, y, data } of tiles) {
        const what = `${name} ${z}/${x}/${y}`;
        const response = await rfetch(`${base}${z}/${x}/${y}.mvt`);
        assert.equal(response.status, 200, what);
        assert.deepEqual(
          new Uint8Array(await response.arrayBuffer()),
          data,
          what,
        );
      }
      for (const place of missing) {
        const response = await rfetch(`${base}${place}.mvt`);
        await response.body?.cancel();
        assert.equal(response.status, 404, `${name} ${place}`);
      }
      // The stored bytes, for a client that decodes them.
      const stored = await rfetch(`${base}9/300/5.mvt`, {
        headers: { "Accept-Encoding": "gzip, br, zstd" },
      });
      const bytes = new Uint8Array(await stored.arrayBuffer());
      if (coding === "identity") {
        assert.equal(stored.headers.get("Content-Encoding"), null);
        assert.equal(new TextDecoder().decode(bytes), "tile 9/300/5");
        continue;
      }
      assert.equal(stored.headers.get("Content-Encoding"), coding, name);
      const extension = COMPRESSIONS.find(([, , c]) => c === coding)?.[3];
      assert.equal(
        new TextDecoder().decode(
          DECODERS[/** @type {keyof DECODERS} */ (extension)](bytes),
        ),
        "tile 9/300/5",
        name,
      );
    }
  });

  test("rfetch lists the tiles of the files of versatiles", async () => {
    const base = `:tiles:${folder}/brotli.versatiles/`;
    const root = await (await lsjson(base)).json();
    // lsjson gives the names in the order of the text, as rclone.
    assert.deepEqual(
      root.map(({ Name }) => Name),
      ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "metadata.json"],
    );
    for (
      const [path, expected] of [
        ["4/", [...Array(16).keys()].map(String).sort()],
        [
          "4/1/",
          [...Array(16).keys()].filter((y) => y % 3 !== 1).map((y) =>
            `${y}.mvt`
          )
            .sort(),
        ],
        ["9/", ["0", "255", "256", "300", "511"]],
        ["9/300/", ["5.mvt"]],
        ["5/", []],
      ]
    ) {
      const list = await (await lsjson(`${base}${path}`)).json();
      assert.deepEqual(list.map(({ Name }) => Name), expected, path);
    }
  });

  test("rfetch reads the raster tiles of versatiles, with their sizes and ranges", async () => {
    const base = `:tiles:${folder}/raster.versatiles/`;
    for (const { z, x, y } of tiles.filter(({ z }) => z <= 2)) {
      const response = await rfetch(`${base}${z}/${x}/${y}.png`);
      assert.equal(response.headers.get("Content-Type"), "image/png");
      assert.equal(response.headers.get("Content-Length"), "9");
      assert.equal(await response.text(), `png ${z}/${x}/${y}`);
    }
    const part = await rfetch(`${base}2/3/1.png`, {
      headers: { Range: "bytes=4-" },
    });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "2/3/1");
  });

  test("versatiles reads the files of the writer of the tests", () => {
    for (const [name, compression, , extension] of COMPRESSIONS) {
      const path = join(folder, `writer-${name}.versatiles`);
      writeFileSync(
        path,
        versatilesFile(tiles, { compression, metadata: { name: "writer" } }),
      );
      const out = join(folder, `writer-${name}`);
      const done = versatiles("convert", path, out);
      assert.equal(done.status, 0, `${name}: ${done.stderr}`);
      const found = readFolder(out);
      assert.equal(found.size, tiles.length, name);
      for (const { z, x, y, data } of tiles) {
        assert.deepEqual(
          found.get(`${z}/${x}/${y}`),
          data,
          `${name} ${z}/${x}/${y}`,
        );
      }
      const metadata = join(out, `tiles.json${extension}`);
      assert.ok(existsSync(metadata), metadata);
      const decode = DECODERS[/** @type {keyof DECODERS} */ (extension)];
      assert.equal(
        JSON.parse(new TextDecoder().decode(decode(readFileSync(metadata))))
          .name,
        "writer",
        name,
      );
    }
  });

  test("rfetch reads the same tiles in a PMTiles file and in its VersaTiles file of versatiles", async () => {
    const pmtiles = join(folder, "writer.pmtiles");
    writeFileSync(pmtiles, pmtilesFile(tiles));
    const done = versatiles(
      "convert",
      pmtiles,
      join(folder, "converted.versatiles"),
    );
    assert.equal(done.status, 0, done.stderr);
    for (const { z, x, y, data } of tiles) {
      const tile = `${z}/${x}/${y}.mvt`;
      for (const file of ["writer.pmtiles", "converted.versatiles"]) {
        const response = await rfetch(`:tiles:${folder}/${file}/${tile}`);
        assert.equal(response.status, 200, `${file} ${tile}`);
        assert.deepEqual(
          new Uint8Array(await response.arrayBuffer()),
          data,
          `${file} ${tile}`,
        );
      }
    }
  });
});
