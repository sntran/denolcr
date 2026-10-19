# The test files of the tiles backend

`fixture.pmtiles` comes from go-pmtiles v1.31.2, the tool of Protomaps, from an
MBTiles file. Thus the tests read a file that rfetch did not write.

- Zoom levels 0 to 3. The tile `Z/X/Y` is `sea` when `(X + Y) % 4` is 0, else
  `tile Z/X/Y`, in gzip. go-pmtiles keeps one copy of the tiles `sea`.
- At the zoom level 3, the file has no tile when `(X * Y) % 3` is 1.
- The metadata have the name `fixture`.

The commands, with Node.js 22.13 or later for `node:sqlite`:

```sh
go install github.com/protomaps/go-pmtiles@v1.31.2
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
const db = new DatabaseSync("fixture.mbtiles");
db.exec("CREATE TABLE metadata (name text, value text)");
db.exec("CREATE TABLE tiles (zoom_level integer, tile_column integer, " +
  "tile_row integer, tile_data blob)");
const metadata = db.prepare("INSERT INTO metadata VALUES (?, ?)");
for (const [name, value] of Object.entries({
  name: "fixture", format: "pbf", minzoom: "0", maxzoom: "3",
  bounds: "-180,-85,180,85", center: "0,0,0",
  json: JSON.stringify({ vector_layers: [{ id: "a", fields: {} }] }),
})) metadata.run(name, value);
db.exec("CREATE UNIQUE INDEX tile_index ON tiles " +
  "(zoom_level, tile_column, tile_row)");
const tile = db.prepare("INSERT INTO tiles VALUES (?, ?, ?, ?)");
for (let z = 0; z <= 3; z++) {
  for (let x = 0; x < 2 ** z; x++) {
    for (let y = 0; y < 2 ** z; y++) {
      if (z === 3 && (x * y) % 3 === 1) continue;
      const text = (x + y) % 4 === 0 ? "sea" : `tile ${z}/${x}/${y}`;
      // MBTiles counts the rows from the south.
      tile.run(z, x, 2 ** z - 1 - y, gzipSync(text));
    }
  }
}
db.close();
'
go-pmtiles convert fixture.mbtiles fixture.pmtiles
```

`fixture.versatiles` comes from versatiles 4.15.0, the tool of VersaTiles, from
a folder of tiles. It has the same tiles and the same name as `fixture.pmtiles`,
and the tool keeps one copy of the tiles `sea` in each block. The tiles and the
metadata are in brotli. The tool writes the blocks and the tiles in no fixed
order: each run of the commands gives other bytes, with the same tiles.

The commands:

```sh
node --input-type=module -e '
import { mkdirSync, writeFileSync } from "node:fs";
for (let z = 0; z <= 3; z++) {
  for (let x = 0; x < 2 ** z; x++) {
    for (let y = 0; y < 2 ** z; y++) {
      if (z === 3 && (x * y) % 3 === 1) continue;
      mkdirSync(`fixture/${z}/${x}`, { recursive: true });
      writeFileSync(
        `fixture/${z}/${x}/${y}.pbf`,
        (x + y) % 4 === 0 ? "sea" : `tile ${z}/${x}/${y}`,
      );
    }
  }
}
writeFileSync("fixture/meta.json", JSON.stringify({
  name: "fixture", vector_layers: [{ id: "a", fields: {} }],
}));
'
versatiles convert --compress brotli "$PWD/fixture" fixture.versatiles
```
