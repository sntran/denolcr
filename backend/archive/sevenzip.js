/**
 * The 7z format of 7-Zip. The parser of the headers has limits: a header
 * from the remote must not make large arrays.
 *
 * A 7z file has its index at its end, as zip, and the start header of 32
 * bytes tells where. 7-Zip compresses the index with LZMA by default, also
 * with `-mx0`: rfetch decodes it.
 *
 * The data of the files are in folders, the blocks of 7z. A folder with the
 * method Copy (`-mx0`) gives each file and each range with one read. A
 * folder with LZMA, LZMA2 or Deflate is a compressed stream: a read of a
 * file decompresses the folder from its start up to the file. A solid
 * archive, the default of 7-Zip, has one folder for many files: then the
 * CPU time of a read grows with the place of the file in the folder.
 *
 * A file with a password, or with another method or a filter, for example
 * BCJ, PPMd or BZip2, gives 501. An archive with a password on its headers
 * gives 501.
 */
import { crc32 } from "@rfetch/lib/crc32";
import { sliceStream } from "@rfetch/lib/range";

import { ArchiveError, checkStream, cleanPath, isoTime } from "./entry.js";
import { lzma2Stream, lzmaStream } from "./lzma.js";

const SIGNATURE = Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c);
const START_SIZE = 32;

/** The limits of a header, and the limit of the index of zip. */
const MAX_HEADER = 16 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_FOLDERS = 100_000;
const MAX_CODERS = 8;

/** The methods of the coders, by their IDs in hexadecimal. */
const COPY = "00";
const LZMA = "030101";
const LZMA2 = "21";
const DEFLATE = "040108";
const AES = "06f10701";

/** The names of the other methods, for the errors. */
const METHODS = {
  "03030103": "BCJ",
  "0303011b": "BCJ2",
  "030401": "PPMd",
  "040202": "BZip2",
  "040109": "Deflate64",
  "03": "Delta",
  "0a": "ARM64",
};

const FORMAT_ERROR = "7z: not a valid 7z file";

const ID = {
  end: 0x00,
  header: 0x01,
  archiveProperties: 0x02,
  additionalStreams: 0x03,
  mainStreams: 0x04,
  filesInfo: 0x05,
  packInfo: 0x06,
  unpackInfo: 0x07,
  substreams: 0x08,
  size: 0x09,
  crc: 0x0a,
  folder: 0x0b,
  unpackSize: 0x0c,
  streamCount: 0x0d,
  emptyStream: 0x0e,
  emptyFile: 0x0f,
  name: 0x11,
  mtime: 0x14,
  attributes: 0x15,
  encodedHeader: 0x17,
};

/**
 * Reads the numbers of a header of 7z: the 7z number (1 to 9 bytes),
 * integers in little endian, and vectors of bits. A read after the end is
 * an error.
 */
class Cursor {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  byte() {
    if (this.offset >= this.bytes.length) throw new ArchiveError(FORMAT_ERROR);
    return this.bytes[this.offset++];
  }

  /** @param {number} length */
  take(length) {
    if (
      !Number.isSafeInteger(length) || length < 0 ||
      this.offset + length > this.bytes.length
    ) {
      throw new ArchiveError(FORMAT_ERROR);
    }
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  /** The 7z number: the high bits of the first byte tell the extra bytes. */
  number() {
    const first = this.byte();
    let mask = 0x80;
    let value = 0;
    for (let index = 0; index < 8; index++) {
      if ((first & mask) === 0) {
        value += (first & (mask - 1)) * 2 ** (8 * index);
        if (!Number.isSafeInteger(value)) throw new ArchiveError(FORMAT_ERROR);
        return value;
      }
      value += this.byte() * 2 ** (8 * index);
      mask >>= 1;
    }
    if (!Number.isSafeInteger(value)) throw new ArchiveError(FORMAT_ERROR);
    return value;
  }

  uint32() {
    const bytes = this.take(4);
    return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
  }

  uint64() {
    const low = this.uint32();
    const high = this.uint32();
    const value = high * 2 ** 32 + low;
    if (!Number.isSafeInteger(value)) throw new ArchiveError(FORMAT_ERROR);
    return value;
  }

  /**
   * A time of Windows, in 100 ns after 1601, as ms after 1970. It is too
   * large for a number of JavaScript, thus it is a BigInt first.
   */
  windowsTime() {
    const bytes = this.take(8);
    const ticks = new DataView(bytes.buffer, bytes.byteOffset, 8)
      .getBigUint64(0, true);
    return Number(ticks / 10_000n) - 11_644_473_600_000;
  }

  /** A vector of bits, the first bit in the high bit of the first byte. */
  bits(count) {
    if (count > MAX_FILES * 2) throw new ArchiveError(FORMAT_ERROR);
    const values = [];
    let current = 0;
    for (let index = 0; index < count; index++) {
      if (index % 8 === 0) current = this.byte();
      values.push((current & (0x80 >> (index % 8))) !== 0);
    }
    return values;
  }

  /** A vector that starts with a byte "all are defined". */
  definedBits(count) {
    return this.byte() === 0 ? this.bits(count) : new Array(count).fill(true);
  }
}

/**
 * A coder of a folder.
 * @typedef {{ id: string, properties: Uint8Array, inputs: number, outputs: number }} Coder
 */

/**
 * A folder: its coders, the bonds between them, and its sizes.
 * @typedef {Object} Folder
 * @property {Coder[]} coders
 * @property {Array<{ input: number, output: number }>} bonds
 * @property {number[]} packed The inputs of the coders that read the
 *   packed streams.
 * @property {number[]} unpackSizes The sizes of the outputs of the coders.
 * @property {number | null} crc
 * @property {number} streamCount The count of files in the folder.
 * @property {number[]} streamSizes
 * @property {Array<number | null>} streamCrcs
 * @property {number} packIndex The index of its first packed stream.
 */

/**
 * The streams of an archive: where the packed streams are, and the folders.
 * @typedef {{ packPosition: number, packSizes: number[], folders: Folder[] }} Streams
 */

/** @param {Folder} folder */
function unpackSizeOf(folder) {
  const bound = new Set(folder.bonds.map(({ output }) => output));
  const main = folder.unpackSizes.findIndex((_, index) => !bound.has(index));
  return folder.unpackSizes[main] ?? 0;
}

/** @param {Cursor} cursor @param {number} count */
function readDigests(cursor, count) {
  const defined = cursor.definedBits(count);
  return defined.map((value) => value ? cursor.uint32() : null);
}

/** @param {Cursor} cursor */
function readFolder(cursor) {
  const count = cursor.number();
  if (count < 1 || count > MAX_CODERS) throw new ArchiveError(FORMAT_ERROR);
  /** @type {Coder[]} */
  const coders = [];
  let inputs = 0;
  let outputs = 0;
  for (let index = 0; index < count; index++) {
    const flags = cursor.byte();
    if (flags & 0x80) throw new ArchiveError(FORMAT_ERROR);
    const id = [...cursor.take(flags & 0x0f)]
      .map((value) => value.toString(16).padStart(2, "0")).join("") || COPY;
    const complex = (flags & 0x10) !== 0;
    const coderInputs = complex ? cursor.number() : 1;
    const coderOutputs = complex ? cursor.number() : 1;
    if (coderInputs > MAX_CODERS || coderOutputs > MAX_CODERS) {
      throw new ArchiveError(FORMAT_ERROR);
    }
    const properties = flags & 0x20
      ? cursor.take(cursor.number())
      : new Uint8Array(0);
    coders.push({ id, properties, inputs: coderInputs, outputs: coderOutputs });
    inputs += coderInputs;
    outputs += coderOutputs;
  }
  if (outputs < 1 || inputs < outputs - 1) throw new ArchiveError(FORMAT_ERROR);
  const bonds = Array.from({ length: outputs - 1 }, () => ({
    input: cursor.number(),
    output: cursor.number(),
  }));
  const packedCount = inputs - bonds.length;
  let packed;
  if (packedCount === 1) {
    const bound = new Set(bonds.map(({ input }) => input));
    packed = [[...Array(inputs).keys()].find((index) => !bound.has(index))];
  } else {
    packed = Array.from({ length: packedCount }, () => cursor.number());
  }
  return {
    coders,
    bonds,
    packed,
    unpackSizes: [],
    crc: null,
    streamCount: 1,
    streamSizes: [],
    streamCrcs: [],
    packIndex: 0,
  };
}

/** @param {Cursor} cursor @returns {Streams} */
function readStreams(cursor) {
  /** @type {Streams} */
  const streams = { packPosition: 0, packSizes: [], folders: [] };
  let substreams = false;
  for (let id = cursor.byte(); id !== ID.end; id = cursor.byte()) {
    if (id === ID.packInfo) {
      streams.packPosition = cursor.number();
      const count = cursor.number();
      if (count > MAX_FOLDERS * MAX_CODERS) {
        throw new ArchiveError(FORMAT_ERROR);
      }
      for (let kind = cursor.byte(); kind !== ID.end; kind = cursor.byte()) {
        if (kind === ID.size) {
          streams.packSizes = Array.from(
            { length: count },
            () => cursor.number(),
          );
        } else if (kind === ID.crc) {
          readDigests(cursor, count);
        } else throw new ArchiveError(FORMAT_ERROR);
      }
    } else if (id === ID.unpackInfo) {
      if (cursor.byte() !== ID.folder) throw new ArchiveError(FORMAT_ERROR);
      const count = cursor.number();
      if (count > MAX_FOLDERS) throw new ArchiveError(FORMAT_ERROR);
      if (cursor.byte() !== 0) throw new ArchiveError(FORMAT_ERROR);
      streams.folders = Array.from({ length: count }, () => readFolder(cursor));
      if (cursor.byte() !== ID.unpackSize) throw new ArchiveError(FORMAT_ERROR);
      for (const folder of streams.folders) {
        const outputs = folder.coders.reduce(
          (sum, coder) => sum + coder.outputs,
          0,
        );
        folder.unpackSizes = Array.from(
          { length: outputs },
          () => cursor.number(),
        );
      }
      for (let kind = cursor.byte(); kind !== ID.end; kind = cursor.byte()) {
        if (kind !== ID.crc) throw new ArchiveError(FORMAT_ERROR);
        readDigests(cursor, count).forEach((crc, index) => {
          streams.folders[index].crc = crc;
        });
      }
    } else if (id === ID.substreams) {
      readSubstreams(cursor, streams.folders);
      substreams = true;
    } else throw new ArchiveError(FORMAT_ERROR);
  }
  let packIndex = 0;
  for (const folder of streams.folders) {
    folder.packIndex = packIndex;
    packIndex += folder.packed.length;
    if (!substreams) {
      folder.streamCount = 1;
      folder.streamSizes = [unpackSizeOf(folder)];
      folder.streamCrcs = [folder.crc];
    }
  }
  if (packIndex > streams.packSizes.length) {
    throw new ArchiveError(FORMAT_ERROR);
  }
  return streams;
}

/** @param {Cursor} cursor @param {Folder[]} folders */
function readSubstreams(cursor, folders) {
  for (const folder of folders) folder.streamCount = 1;
  let id = cursor.byte();
  if (id === ID.streamCount) {
    let total = 0;
    for (const folder of folders) {
      folder.streamCount = cursor.number();
      total += folder.streamCount;
      if (total > MAX_FILES) throw new ArchiveError(FORMAT_ERROR);
    }
    id = cursor.byte();
  }
  for (const folder of folders) {
    const total = unpackSizeOf(folder);
    const sizes = [];
    if (id === ID.size) {
      for (let index = 1; index < folder.streamCount; index++) {
        sizes.push(cursor.number());
      }
    }
    const used = sizes.reduce((sum, size) => sum + size, 0);
    if (folder.streamCount > 0) {
      if (used > total) throw new ArchiveError(FORMAT_ERROR);
      sizes.push(total - used);
    }
    folder.streamSizes = sizes;
    folder.streamCrcs = sizes.map(() => null);
    if (folder.streamCount === 1 && folder.crc !== null) {
      folder.streamCrcs = [folder.crc];
    }
  }
  if (id === ID.size) id = cursor.byte();
  while (id !== ID.end) {
    if (id !== ID.crc) throw new ArchiveError(FORMAT_ERROR);
    // The CRCs of the files that the folder does not tell.
    const unknown = folders.filter((folder) =>
      !(folder.streamCount === 1 && folder.crc !== null)
    );
    const count = unknown.reduce((sum, folder) => sum + folder.streamCount, 0);
    const digests = readDigests(cursor, count);
    let next = 0;
    for (const folder of unknown) {
      for (let index = 0; index < folder.streamCount; index++) {
        folder.streamCrcs[index] = digests[next++];
      }
    }
    id = cursor.byte();
  }
}

/**
 * A file of the header.
 * @typedef {{ name: string, emptyStream: boolean, emptyFile: boolean,
 *   attributes: number | null, mtime: number | null }} HeaderFile
 */

/** @param {Cursor} cursor @returns {HeaderFile[]} */
function readFiles(cursor) {
  const count = cursor.number();
  if (count > MAX_FILES) {
    throw new ArchiveError(`7z: more than ${MAX_FILES} files`, 501);
  }
  /** @type {HeaderFile[]} */
  const files = Array.from({ length: count }, () => ({
    name: "",
    emptyStream: false,
    emptyFile: false,
    attributes: null,
    mtime: null,
  }));
  let empty = [];
  for (let type = cursor.number(); type !== ID.end; type = cursor.number()) {
    const property = new Cursor(cursor.take(cursor.number()));
    if (type === ID.emptyStream) {
      property.bits(count).forEach((value, index) => {
        files[index].emptyStream = value;
      });
      empty = files.filter((file) => file.emptyStream);
    } else if (type === ID.emptyFile) {
      property.bits(empty.length).forEach((value, index) => {
        empty[index].emptyFile = value;
      });
    } else if (type === ID.name) {
      if (property.byte() !== 0) throw new ArchiveError(FORMAT_ERROR);
      for (const file of files) file.name = readName(property);
    } else if (type === ID.mtime || type === ID.attributes) {
      const defined = property.definedBits(count);
      if (property.byte() !== 0) throw new ArchiveError(FORMAT_ERROR);
      defined.forEach((value, index) => {
        if (!value) return;
        if (type === ID.mtime) {
          files[index].mtime = property.windowsTime();
        } else {
          files[index].attributes = property.uint32();
        }
      });
    }
  }
  return files;
}

/** A name in UTF-16, with a NUL at its end. @param {Cursor} cursor */
function readName(cursor) {
  const units = [];
  for (;;) {
    const unit = cursor.byte() | cursor.byte() << 8;
    if (unit === 0) break;
    units.push(unit);
  }
  let name = "";
  for (let index = 0; index < units.length; index += 4096) {
    name += String.fromCharCode(...units.slice(index, index + 4096));
  }
  return name;
}

/**
 * Reads the start header and the index of a 7z file.
 * @param {import("@rfetch/lib/ranged").RangedFile} file
 * @returns {Promise<import("./entry.js").Entry[]>}
 */
export async function open7z(file) {
  const start = await file.read(0, START_SIZE);
  if (
    start.length < START_SIZE ||
    SIGNATURE.some((value, index) => start[index] !== value)
  ) {
    throw new ArchiveError(FORMAT_ERROR);
  }
  if (start[6] !== 0) throw new ArchiveError("7z: unsupported version", 501);
  const fields = new Cursor(start.subarray(8));
  const startCrc = fields.uint32();
  if (crc32(start.subarray(12, 32)) !== startCrc) {
    throw new ArchiveError("7z: the CRC of the start header is not correct");
  }
  const offset = fields.uint64();
  const size = fields.uint64();
  const headerCrc = fields.uint32();
  // An archive with no file.
  if (size === 0) return [];
  if (size > MAX_HEADER) {
    throw new ArchiveError(
      `7z: the index is larger than ${MAX_HEADER} bytes`,
      501,
    );
  }
  let header = await file.read(START_SIZE + offset, size);
  if (header.length !== size || crc32(header) !== headerCrc) {
    throw new ArchiveError("7z: the CRC of the index is not correct");
  }

  // The index can be in a folder with LZMA: then the header tells where.
  for (let level = 0; header[0] === ID.encodedHeader; level++) {
    if (level > 3) throw new ArchiveError(FORMAT_ERROR);
    const cursor = new Cursor(header);
    cursor.byte();
    const streams = readStreams(cursor);
    const folder = streams.folders[0];
    if (!folder || streams.folders.length !== 1) {
      throw new ArchiveError(FORMAT_ERROR);
    }
    if (folder.coders.some(({ id }) => id === AES)) {
      throw new ArchiveError(
        "7z: an archive with a password on its headers is not supported",
        501,
      );
    }
    const unpacked = unpackSizeOf(folder);
    if (unpacked > MAX_HEADER) {
      throw new ArchiveError(
        `7z: the index is larger than ${MAX_HEADER} bytes`,
        501,
      );
    }
    const stream = await openFolder(file, streams, folder);
    header = new Uint8Array(await new Response(stream).arrayBuffer());
    if (header.length !== unpacked) throw new ArchiveError(FORMAT_ERROR);
    if (folder.crc !== null && crc32(header) !== folder.crc) {
      throw new ArchiveError("7z: the CRC of the index is not correct");
    }
  }

  const cursor = new Cursor(header);
  if (cursor.byte() !== ID.header) throw new ArchiveError(FORMAT_ERROR);
  /** @type {Streams} */
  let streams = { packPosition: 0, packSizes: [], folders: [] };
  /** @type {HeaderFile[]} */
  let files = [];
  for (let id = cursor.byte(); id !== ID.end; id = cursor.byte()) {
    if (id === ID.archiveProperties) {
      for (let kind = cursor.byte(); kind !== ID.end; kind = cursor.byte()) {
        cursor.take(cursor.number());
      }
    } else if (id === ID.additionalStreams) readStreams(cursor);
    else if (id === ID.mainStreams) streams = readStreams(cursor);
    else if (id === ID.filesInfo) files = readFiles(cursor);
    else throw new ArchiveError(FORMAT_ERROR);
  }
  return entriesOf(file, streams, files);
}

/**
 * The entries of the files of the header: each file with data takes the
 * next stream of the folders, in order.
 * @param {import("@rfetch/lib/ranged").RangedFile} file
 * @param {Streams} streams
 * @param {HeaderFile[]} files
 */
function entriesOf(file, streams, files) {
  /** @type {import("./entry.js").Entry[]} */
  const entries = [];
  let folder = 0;
  let stream = 0;
  let offset = 0;
  for (const item of files) {
    let place = null;
    let size = 0;
    let crc = null;
    if (!item.emptyStream) {
      while (
        folder < streams.folders.length &&
        stream >= streams.folders[folder].streamCount
      ) {
        folder++;
        stream = 0;
        offset = 0;
      }
      const current = streams.folders[folder];
      if (!current) throw new ArchiveError(FORMAT_ERROR);
      size = current.streamSizes[stream];
      crc = current.streamCrcs[stream] ?? null;
      place = { folder: current, offset };
      offset += size;
      stream++;
    }
    const isDir = item.emptyStream
      ? !item.emptyFile
      : item.attributes !== null && (item.attributes & 0x10) !== 0;
    const path = cleanPath(item.name.replaceAll("\\", "/"));
    if (!path) continue;
    entries.push({
      path,
      isDir,
      size,
      modTime: item.mtime === null ? "" : isoTime(item.mtime),
      open: (range) => openFile(file, streams, place, size, crc, range),
    });
  }
  return entries;
}

/**
 * Gives the bytes of a file of a folder.
 * @param {import("@rfetch/lib/ranged").RangedFile} file
 * @param {Streams} streams
 * @param {{ folder: Folder, offset: number } | null} place
 * @param {number} size
 * @param {number | null} crc
 * @param {{ start: number, end: number } | null} range
 */
async function openFile(file, streams, place, size, crc, range) {
  const check = () => checkStream({ size, crc, format: "7z" });
  if (!place || size === 0) return new Blob([]).stream().pipeThrough(check());
  const { folder, offset } = place;
  const start = offset + (range ? range.start : 0);
  const length = range ? range.end - range.start + 1 : size;
  if (folder.coders.length === 1 && folder.coders[0].id === COPY) {
    // The data are in the archive as they are.
    const stream = await file.stream(
      packStart(streams, folder) + start,
      length,
    );
    return range ? stream : stream.pipeThrough(check());
  }
  const stream = sliceStream(
    await openFolder(file, streams, folder),
    start,
    length,
  );
  return range ? stream : stream.pipeThrough(check());
}

/**
 * The offset of the first packed stream of a folder.
 * @param {Streams} streams
 * @param {Folder} folder
 */
function packStart(streams, folder) {
  let offset = START_SIZE + streams.packPosition;
  for (let index = 0; index < folder.packIndex; index++) {
    offset += streams.packSizes[index];
  }
  return offset;
}

/**
 * The unpacked stream of a folder with one coder.
 * @param {import("@rfetch/lib/ranged").RangedFile} file
 * @param {Streams} streams
 * @param {Folder} folder
 * @returns {Promise<ReadableStream<Uint8Array>>}
 */
async function openFolder(file, streams, folder) {
  if (folder.coders.some(({ id }) => id === AES)) {
    throw new ArchiveError("7z: a file with a password is not supported", 501);
  }
  if (folder.coders.length !== 1) {
    const names = folder.coders.map(({ id }) => METHODS[id] ?? id).join(" ");
    throw new ArchiveError(`7z: the methods ${names} are not supported`, 501);
  }
  const [coder] = folder.coders;
  const size = unpackSizeOf(folder);
  let decoder;
  if (coder.id === LZMA) decoder = lzmaStream(coder.properties, size);
  else if (coder.id === LZMA2) decoder = lzma2Stream(coder.properties, size);
  else if (coder.id === DEFLATE) {
    decoder = new DecompressionStream("deflate-raw");
  } else if (coder.id !== COPY) {
    throw new ArchiveError(
      `7z: the method ${METHODS[coder.id] ?? coder.id} is not supported`,
      501,
    );
  }
  const packed = await file.stream(
    packStart(streams, folder),
    streams.packSizes[folder.packIndex],
  );
  return decoder ? packed.pipeThrough(decoder) : packed;
}
