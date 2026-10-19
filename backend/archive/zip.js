/**
 * The zip format, as `archive/zip` of Go, which the archive backend of
 * rclone uses. The index of a zip file (the central directory) is at its
 * end. Thus a list needs the end of the file, and a read of one file needs
 * the end, then its local header and its data.
 *
 * rfetch reads the methods Store and Deflate, as Go. A file with another
 * method, or with a password, gives 501. ZIP64 works, and so do data
 * before the zip file, for example a program that extracts the files.
 */
import { sliceStream } from "@rfetch/lib/range";

import { ArchiveError, checkStream, cleanPath, isoTime } from "./entry.js";

/** The signatures of the records. */
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;

/** The sizes of the records with no names. */
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const END_SIZE = 22;
const LOCATOR64_SIZE = 20;
const END64_SIZE = 56;

/** The IDs of the extra fields. */
const ZIP64_EXTRA = 0x0001;
const NTFS_EXTRA = 0x000a;
const UNIX_EXTRA = 0x000d;
const EXTENDED_TIME_EXTRA = 0x5455;
const INFO_ZIP_UNIX_EXTRA = 0x5855;

/**
 * The end of the file that has the end record, as Go: the record and a
 * comment of at most 65,535 bytes.
 */
const TAIL = 65 * 1024;

/**
 * The largest index that rfetch reads, about 200,000 files. The index
 * comes all into memory.
 */
export const MAX_INDEX = 16 * 1024 * 1024;

const FORMAT_ERROR = "zip: not a valid zip file";

/** The names of a zip file are UTF-8, as Go reads them. */
const decoder = new TextDecoder();

/**
 * Reads the numbers of a record, in little endian.
 */
class Record {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** @param {number} offset */
  u16(offset) {
    return this.view.getUint16(offset, true);
  }

  /** @param {number} offset */
  u32(offset) {
    return this.view.getUint32(offset, true);
  }

  /** @param {number} offset */
  u64(offset) {
    const value = this.view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ArchiveError(FORMAT_ERROR);
    }
    return Number(value);
  }
}

/**
 * The place of the end record in the end of the file, as
 * `findSignatureInBlock` of Go: the last signature, with its comment in the
 * file.
 * @param {Uint8Array} tail
 * @returns {number} -1 when there is no end record.
 */
function findEnd(tail) {
  for (let index = tail.length - END_SIZE; index >= 0; index--) {
    if (
      tail[index] === 0x50 && tail[index + 1] === 0x4b &&
      tail[index + 2] === 0x05 && tail[index + 3] === 0x06
    ) {
      const comment = tail[index + 20] | tail[index + 21] << 8;
      return index + END_SIZE + comment > tail.length ? -1 : index;
    }
  }
  return -1;
}

/**
 * The time of a file of a zip file, as Go: the last time of the extra
 * fields, else the MS-DOS time, as UTC.
 * @param {number} date
 * @param {number} time
 * @param {Uint8Array} extra
 * @returns {string}
 */
function timeOf(date, time, extra) {
  /** @type {number | null} The time in ms. */
  let modified = null;
  for (let at = 0; at + 4 <= extra.length;) {
    const field = new Record(extra.subarray(at));
    const tag = field.u16(0);
    const size = field.u16(2);
    if (at + 4 + size > extra.length) break;
    const data = new Record(extra.subarray(at + 4, at + 4 + size));
    at += 4 + size;
    if (tag === NTFS_EXTRA && size >= 4) {
      // A reserved number, then attributes: the attribute 1 has the times.
      for (let offset = 4; offset + 4 <= size;) {
        const attribute = data.u16(offset);
        const length = data.u16(offset + 2);
        if (offset + 4 + length > size) break;
        if (attribute === 1 && length === 24) {
          // The time in 100 ns after 1601.
          const ticks = data.view.getBigInt64(offset + 4, true);
          modified = Number(ticks / 10_000_000n - 11_644_473_600n) * 1000;
        }
        offset += 4 + length;
      }
    } else if (
      (tag === UNIX_EXTRA || tag === INFO_ZIP_UNIX_EXTRA) && size >= 8
    ) {
      // The time of the last access, then the time of the last change.
      modified = data.u32(4) * 1000;
    } else if (
      tag === EXTENDED_TIME_EXTRA && size >= 5 && data.bytes[0] & 1
    ) {
      modified = data.u32(1) * 1000;
    }
  }
  if (modified !== null) return isoTime(modified);
  return isoTime(Date.UTC(
    1980 + (date >> 9),
    ((date >> 5) & 0xf) - 1,
    date & 0x1f,
    time >> 11,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  ));
}

/**
 * Reads the index of a zip file.
 * @param {import("@rfetch/lib/ranged").RangedFile} file
 * @returns {Promise<import("./entry.js").Entry[]>}
 */
export async function openZip(file) {
  const tail = await file.tail(TAIL);
  const size = file.size ?? tail.length;
  const tailStart = size - tail.length;
  /**
   * Reads bytes of the file, from the end that the backend has, else with a
   * new request.
   * @param {number} offset
   * @param {number} length
   */
  const read = (offset, length) =>
    offset >= tailStart && offset + length <= size
      ? Promise.resolve(
        tail.subarray(offset - tailStart, offset - tailStart + length),
      )
      : file.read(offset, length);

  const position = findEnd(tail);
  if (position < 0) throw new ArchiveError(FORMAT_ERROR);
  let endOffset = tailStart + position;
  const end = new Record(tail.subarray(position));
  let records = end.u16(10);
  let indexSize = end.u32(12);
  let indexOffset = end.u32(16);

  // These values tell a ZIP64 file.
  if (
    records === 0xffff || indexSize === 0xffff || indexOffset === 0xffffffff
  ) {
    const at = endOffset - LOCATOR64_SIZE;
    const locator = at < 0 ? null : new Record(await read(at, LOCATOR64_SIZE));
    if (
      locator?.bytes.length === LOCATOR64_SIZE &&
      locator.u32(0) === LOCATOR64 && locator.u32(4) === 0 &&
      locator.u32(16) === 1
    ) {
      const place = locator.u64(8);
      const record = new Record(await read(place, END64_SIZE));
      if (record.bytes.length < END64_SIZE || record.u32(0) !== END64) {
        throw new ArchiveError(FORMAT_ERROR);
      }
      records = record.u64(32);
      indexSize = record.u64(40);
      indexOffset = record.u64(48);
      endOffset = place;
    }
  }

  // The bytes before the zip file, for example a program.
  let base = endOffset - indexSize - indexOffset;
  if (base + indexOffset < 0 || base + indexOffset >= size) {
    throw new ArchiveError(FORMAT_ERROR);
  }
  if (base > 0) {
    // Some files tell a wrong base: as Go, the base is 0 when the index is
    // at its offset.
    const probe = await read(indexOffset, 4);
    if (probe.length === 4 && new Record(probe).u32(0) === CENTRAL) base = 0;
  }
  if (indexSize > MAX_INDEX) {
    throw new ArchiveError(
      `zip: the index is larger than ${MAX_INDEX} bytes`,
      501,
    );
  }
  const index = await read(base + indexOffset, indexSize);

  /** @type {import("./entry.js").Entry[]} */
  const entries = [];
  let count = 0;
  for (let offset = 0; offset + CENTRAL_SIZE <= index.length;) {
    const header = new Record(index.subarray(offset));
    if (header.u32(0) !== CENTRAL) break;
    const nameLength = header.u16(28);
    const extraLength = header.u16(30);
    const length = CENTRAL_SIZE + nameLength + extraLength + header.u16(32);
    if (offset + length > index.length) break;
    const flags = header.u16(8);
    const method = header.u16(10);
    const crc = header.u32(16);
    let compressed = header.u32(20);
    let uncompressed = header.u32(24);
    let local = header.u32(42);
    const name = decoder.decode(
      index.subarray(offset + CENTRAL_SIZE, offset + CENTRAL_SIZE + nameLength),
    );
    const extra = index.subarray(
      offset + CENTRAL_SIZE + nameLength,
      offset + CENTRAL_SIZE + nameLength + extraLength,
    );

    // The ZIP64 field has the sizes and the offset that are too large for
    // the header, in this order.
    let needSize = uncompressed === 0xffffffff;
    let needCompressed = compressed === 0xffffffff;
    let needLocal = local === 0xffffffff;
    for (let at = 0; at + 4 <= extra.length;) {
      const field = new Record(extra.subarray(at));
      const tag = field.u16(0);
      const fieldSize = field.u16(2);
      if (at + 4 + fieldSize > extra.length) break;
      if (tag === ZIP64_EXTRA) {
        const data = new Record(extra.subarray(at + 4, at + 4 + fieldSize));
        let next = 0;
        /** The next number of 8 bytes of the field. */
        const take = () => {
          if (next + 8 > fieldSize) throw new ArchiveError(FORMAT_ERROR);
          next += 8;
          return data.u64(next - 8);
        };
        if (needSize) {
          needSize = false;
          uncompressed = take();
        }
        if (needCompressed) {
          needCompressed = false;
          compressed = take();
        }
        if (needLocal) {
          needLocal = false;
          local = take();
        }
      }
      at += 4 + fieldSize;
    }
    if (needCompressed || needLocal) throw new ArchiveError(FORMAT_ERROR);

    count++;
    offset += length;
    const path = cleanPath(name);
    if (!path) continue;
    const details = {
      flags,
      method,
      crc,
      compressed,
      size: uncompressed,
      local: base + local,
    };
    entries.push({
      path,
      isDir: name.endsWith("/"),
      size: uncompressed,
      modTime: timeOf(header.u16(14), header.u16(12), extra),
      open: (range) => openEntry(file, details, range),
    });
  }
  // As Go, only the low 16 bits of the count must be the same.
  if ((count & 0xffff) !== records % 0x10000) {
    throw new ArchiveError(FORMAT_ERROR);
  }
  return entries;
}

/**
 * Gives the bytes of a file of a zip file.
 * @param {import("@rfetch/lib/ranged").RangedFile} file
 * @param {{
 *   flags: number,
 *   method: number,
 *   crc: number,
 *   compressed: number,
 *   size: number,
 *   local: number,
 * }} entry
 * @param {{ start: number, end: number } | null} range
 * @returns {Promise<ReadableStream<Uint8Array>>}
 */
async function openEntry(file, entry, range) {
  if (entry.flags & 1) {
    throw new ArchiveError("zip: a file with a password is not supported", 501);
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ArchiveError("zip: unsupported compression algorithm", 501);
  }
  const header = await file.read(entry.local, LOCAL_SIZE);
  if (header.length < LOCAL_SIZE || new Record(header).u32(0) !== LOCAL) {
    throw new ArchiveError(FORMAT_ERROR);
  }
  const local = new Record(header);
  const data = entry.local + LOCAL_SIZE + local.u16(26) + local.u16(28);
  // As Go, the CRC-32 is not checked when it is 0 and the file has no data
  // descriptor.
  const check = () =>
    checkStream({
      size: entry.size,
      crc: entry.crc !== 0 || entry.flags & 8 ? entry.crc : null,
      format: "zip",
    });

  if (entry.size === 0) return new Blob([]).stream().pipeThrough(check());
  if (entry.method === 0) {
    if (range) {
      return await file.stream(data + range.start, range.end - range.start + 1);
    }
    return (await file.stream(data, entry.compressed)).pipeThrough(check());
  }
  const inflated = (await file.stream(data, entry.compressed))
    .pipeThrough(new DecompressionStream("deflate-raw"));
  if (range) {
    return sliceStream(inflated, range.start, range.end - range.start + 1);
  }
  return inflated.pipeThrough(check());
}
