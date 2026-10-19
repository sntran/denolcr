/**
 * The parts that the readers of the formats of tiles share: the errors, the
 * encodings of the tiles, and the types of the tiles.
 *
 * A reader gives a tile set:
 *
 * - `format`: the name of the format, for the errors, for example
 *   `pmtiles`.
 * - `minZoom` and `maxZoom`: the zoom levels of the tiles.
 * - `type`: the type of the tiles, for example `mvt` or `png`, or "" for a
 *   type that is not known.
 * - `encoding`: the encoding of the stored tiles, as the content codings of
 *   HTTP: `identity`, `gzip`, `br` or `zstd`.
 * - `metadata()`: the metadata, in JSON.
 * - `tile(z, x, y)`: the place of a tile in the file, or null.
 * - `zoom(z, limit)`: the tiles of a zoom level, in no order.
 */

/** An error in a file of tiles, or a part of a format that rfetch does not read. */
export class TilesError extends Error {
  /**
   * @param {string} message
   * @param {number} [status] 500 for a file that is not correct, 501 for a
   *   part of the format that rfetch does not read.
   */
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

/**
 * A tile set of a file.
 * @typedef {Object} TileSet
 * @property {string} format
 * @property {number} minZoom
 * @property {number} maxZoom
 * @property {string} type
 * @property {string} encoding
 * @property {() => Promise<Uint8Array>} metadata
 * @property {(z: number, x: number, y: number) =>
 *   Promise<{ offset: number, length: number } | null>} tile
 * @property {(z: number, limit: number) =>
 *   Promise<Array<{ x: number, y: number, length: number }>>} zoom
 */

/** The most bytes after a decompression in memory. */
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * The formats of `DecompressionStream`, and the names for the errors, by
 * content coding.
 */
const CODINGS = new Map([
  ["gzip", ["gzip", "gzip"]],
  ["br", ["brotli", "brotli"]],
  ["zstd", ["zstd", "zstd"]],
]);

/**
 * A stream that decodes data, or undefined for `identity`.
 * @param {string} encoding A content coding.
 * @param {string} format The name of the format, for the error.
 * @param {string} what For the error, for example "the tiles".
 * @returns {DecompressionStream | undefined}
 * @throws {TilesError} 501 when the runtime does not decode the encoding.
 */
export function decoder(encoding, format, what) {
  if (encoding === "identity") return undefined;
  const [stream, name] = CODINGS.get(encoding) ?? [undefined, encoding];
  if (stream) {
    try {
      return new DecompressionStream(/** @type {CompressionFormat} */ (stream));
    } catch {
      // The runtime does not have the format.
    }
  }
  throw new TilesError(
    `${format}: the compression ${name} of ${what} is not supported`,
    501,
  );
}

/**
 * Decodes a part of a file in memory, of at most 32 MiB after the decoding.
 * @param {Uint8Array} bytes
 * @param {string} encoding
 * @param {string} format
 * @param {string} what
 */
export async function decompress(bytes, encoding, format, what) {
  const stream = decoder(encoding, format, what);
  if (!stream) return bytes;
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new TilesError(
          `${format}: ${what} has more than ${MAX_BYTES} bytes`,
          501,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TilesError) throw error;
    throw new TilesError(`${format}: ${what} is not correct compressed data`);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** The media types of the tiles, by type. */
const TYPES = new Map([
  ["mvt", "application/vnd.mapbox-vector-tile"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["mlt", "application/vnd.maplibre-tile"],
]);

/**
 * The extension of the names of the tiles, with its dot, and their media
 * type. A type that is not known has no extension.
 * @param {string} type
 */
export function typeOf(type) {
  const mime = TYPES.get(type);
  return mime
    ? { extension: `.${type}`, mime }
    : { extension: "", mime: "application/octet-stream" };
}

/**
 * Tells if a request accepts a content coding, from its `Accept-Encoding`,
 * as RFC 9110: a coding with `q=0` is not acceptable, and `*` is any coding
 * that the header does not name.
 * @param {string | null} header
 * @param {string} encoding
 */
export function accepts(header, encoding) {
  if (!header) return false;
  /** @type {number | undefined} */
  let star;
  for (const part of header.split(",")) {
    const [name, ...parameters] = part.split(";").map((text) => text.trim());
    let q = 1;
    for (const parameter of parameters) {
      const match = /^q\s*=\s*([0-9.]+)$/i.exec(parameter);
      if (match) q = Number(match[1]);
    }
    const coding = name.toLowerCase();
    if (coding === encoding) return q > 0;
    if (coding === "*") star = q;
  }
  return star !== undefined && star > 0;
}
