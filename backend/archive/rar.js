/**
 * The RAR format, versions 4 (RAR 1.5 to 4.x) and 5, in store mode. The
 * format is from the technical notes of RARLAB.
 *
 * A RAR file has no index: each file has its header before its data. Thus
 * a list reads the headers one after the other, in parts of 64 KiB, and a
 * header after large data needs a new request. A read of a stored file is
 * a read of its data, also for a range.
 *
 * rfetch reads only the files in store mode (`rar -m0`): RAR has its own
 * compression, which no Web API reads. A compressed file, a file with a
 * password, and a file in more than one volume are in the list, and give
 * 501. An archive with a password on its headers gives 501.
 */
import { crc32 } from "@rfetch/lib/crc32";

import { ArchiveError, checkStream, cleanPath, isoTime } from "./entry.js";

const RAR4 = Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00);
const RAR5 = Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00);

/** The size of each read of the headers. */
const CHUNK = 64 * 1024;

/** The largest header. */
const MAX_HEADER = 2 * 1024 * 1024;

/** The most files in an archive. */
const MAX_FILES = 100_000;

const FORMAT_ERROR = "rar: not a valid RAR file";
const decoder = new TextDecoder();

/**
 * Reads the bytes of the headers, with a window of the last read.
 */
class Cursor {
  /** @type {Uint8Array} */
  window = new Uint8Array(0);
  start = 0;

  /** @param {import("@rfetch/lib/ranged").RangedFile} file */
  constructor(file) {
    this.file = file;
  }

  /**
   * Gives the bytes at an offset, or fewer at the end of the file.
   * @param {number} offset
   * @param {number} length
   */
  async bytes(offset, length) {
    const end = offset + length;
    if (offset < this.start || end > this.start + this.window.length) {
      this.window = await this.file.read(offset, Math.max(length, CHUNK));
      this.start = offset;
    }
    return this.window.subarray(offset - this.start, end - this.start);
  }

  /**
   * Gives exactly `length` bytes at an offset.
   * @param {number} offset
   * @param {number} length
   */
  async exact(offset, length) {
    const bytes = await this.bytes(offset, length);
    if (bytes.length < length) {
      throw new ArchiveError("rar: unexpected end of file");
    }
    return bytes;
  }
}

/**
 * Reads the numbers of a header, in little endian, and the numbers of
 * variable size of RAR5.
 */
class Fields {
  /**
   * @param {Uint8Array} bytes
   * @param {number} [offset]
   * @param {number} [end]
   */
  constructor(bytes, offset = 0, end = bytes.length) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
    this.end = end;
  }

  /** @param {number} length */
  #take(length) {
    if (this.offset + length > this.end) throw new ArchiveError(FORMAT_ERROR);
    const at = this.offset;
    this.offset += length;
    return at;
  }

  u8() {
    return this.bytes[this.#take(1)];
  }

  u16() {
    return this.view.getUint16(this.#take(2), true);
  }

  u32() {
    return this.view.getUint32(this.#take(4), true);
  }

  u64() {
    const value = this.view.getBigUint64(this.#take(8), true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ArchiveError(FORMAT_ERROR);
    }
    return Number(value);
  }

  /** @param {number} length */
  take(length) {
    const at = this.#take(length);
    return this.bytes.subarray(at, at + length);
  }

  /** A number of RAR5: 7 bits in each byte, the low bits first. */
  vint() {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = this.u8();
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) {
        if (!Number.isSafeInteger(value)) throw new ArchiveError(FORMAT_ERROR);
        return value;
      }
    }
    throw new ArchiveError(FORMAT_ERROR);
  }
}

/**
 * Reads the headers of a RAR file.
 * @param {import("@rfetch/lib/ranged").RangedFile} file
 * @returns {Promise<import("./entry.js").Entry[]>}
 */
export async function openRar(file) {
  const cursor = new Cursor(file);
  const start = await cursor.bytes(0, RAR5.length);
  if (
    start.length === RAR5.length && RAR5.every((byte, i) => byte === start[i])
  ) {
    return await rar5(file, cursor);
  }
  if (RAR4.every((byte, i) => byte === start[i])) {
    return await rar4(file, cursor);
  }
  throw new ArchiveError(FORMAT_ERROR);
}

/**
 * The details of a file of a RAR file, to read it.
 * @typedef {Object} RarFile
 * @property {string} name The name in the archive, with `/`.
 * @property {boolean} isDir
 * @property {number} size The size of the file.
 * @property {number} packed The size of the data in this volume.
 * @property {number} data The offset of the data.
 * @property {number | null} crc The CRC-32 of the data, or null.
 * @property {string} modTime
 * @property {string | null} error Why rfetch cannot read the file, or null.
 */

/**
 * The entries of the files of a RAR file.
 * @param {import("@rfetch/lib/ranged").RangedFile} file
 * @param {RarFile[]} files
 * @returns {import("./entry.js").Entry[]}
 */
function entriesOf(file, files) {
  /** @type {import("./entry.js").Entry[]} */
  const entries = [];
  for (const item of files) {
    const path = cleanPath(item.name);
    if (!path) continue;
    entries.push({
      path,
      isDir: item.isDir,
      size: item.size,
      modTime: item.modTime,
      open: (range) => openFile(file, item, range),
    });
  }
  return entries;
}

/**
 * Gives the bytes of a stored file.
 * @param {import("@rfetch/lib/ranged").RangedFile} file
 * @param {RarFile} item
 * @param {{ start: number, end: number } | null} range
 */
async function openFile(file, item, range) {
  if (item.error) throw new ArchiveError(item.error, 501);
  if (range) {
    return await file.stream(
      item.data + range.start,
      range.end - range.start + 1,
    );
  }
  const stream = await file.stream(item.data, item.packed);
  return stream.pipeThrough(
    checkStream({ size: item.size, crc: item.crc, format: "rar" }),
  );
}

/**
 * Reads the headers of RAR5.
 * @param {import("@rfetch/lib/ranged").RangedFile} file
 * @param {Cursor} cursor
 */
async function rar5(file, cursor) {
  /** @type {RarFile[]} */
  const files = [];
  let offset = RAR5.length;
  let first = true;
  while (true) {
    // The CRC, then the size of the header in at most 3 bytes.
    const prefix = await cursor.bytes(offset, 7);
    if (prefix.length === 0) break;
    const sizeField = new Fields(prefix, 4);
    const size = sizeField.vint();
    const length = sizeField.offset + size;
    if (size < 2 || length > MAX_HEADER) throw new ArchiveError(FORMAT_ERROR);
    const header = await cursor.exact(offset, length);
    const fields = new Fields(header);
    if (crc32(header.subarray(4)) !== fields.u32()) {
      throw new ArchiveError("rar: header CRC error");
    }
    fields.vint();
    const type = fields.vint();
    const flags = fields.vint();
    const extraSize = flags & 0x01 ? fields.vint() : 0;
    const dataSize = flags & 0x02 ? fields.vint() : 0;
    const extraStart = length - extraSize;
    if (extraStart < fields.offset) throw new ArchiveError(FORMAT_ERROR);
    const data = offset + length;

    if (first && type === 4) {
      throw new ArchiveError(
        "rar: an archive with a password on its headers is not supported",
        501,
      );
    }
    first = false;
    if (type === 5) break;
    if (type === 2) {
      if (files.length >= MAX_FILES) {
        throw new ArchiveError(`rar: more than ${MAX_FILES} files`, 501);
      }
      const item = rar5File(header, fields, extraStart, flags, data, dataSize);
      if (item) files.push(item);
    }
    offset = data + dataSize;
  }
  return entriesOf(file, files);
}

/**
 * A file of RAR5, or null for a part of a file that starts in a volume
 * before, or for a link.
 * @param {Uint8Array} header
 * @param {Fields} fields After the common fields of the header.
 * @param {number} extraStart
 * @param {number} flags The flags of the header.
 * @param {number} data
 * @param {number} dataSize
 * @returns {RarFile | null}
 */
function rar5File(header, fields, extraStart, flags, data, dataSize) {
  const fileFlags = fields.vint();
  let size = fields.vint();
  fields.vint(); // The attributes.
  let time = fileFlags & 0x02 ? fields.u32() * 1000 : null;
  const crc = fileFlags & 0x04 ? fields.u32() : null;
  const compression = fields.vint();
  fields.vint(); // The system of the archiver.
  const name = decoder.decode(fields.take(fields.vint()));
  if (fileFlags & 0x08) size = dataSize;

  let encrypted = false;
  const extra = new Fields(header, extraStart);
  while (extra.offset < header.length) {
    const recordSize = extra.vint();
    const end = extra.offset + recordSize;
    if (recordSize < 1 || end > header.length) {
      throw new ArchiveError(FORMAT_ERROR);
    }
    const record = new Fields(header, extra.offset, end);
    const type = record.vint();
    if (type === 1) encrypted = true;
    // A link, not a file.
    if (type === 5) return null;
    if (type === 3) {
      const timeFlags = record.vint();
      if (timeFlags & 0x02) {
        time = timeFlags & 0x01
          ? record.u32() * 1000
          : windowsTime(record.u64());
      }
    }
    extra.offset = end;
  }

  // A part of a file that starts in a volume before.
  if (flags & 0x08) return null;
  const method = (compression >> 7) & 0x07;
  let error = null;
  if (encrypted) error = "rar: a file with a password is not supported";
  else if (flags & 0x10) {
    error = "rar: a file in more than one volume is not supported";
  } else if (method !== 0) error = "rar: a compressed file is not supported";
  else if (dataSize !== size) error = FORMAT_ERROR;
  return {
    name,
    isDir: Boolean(fileFlags & 0x01),
    size,
    packed: dataSize,
    data,
    crc,
    modTime: time === null ? "" : isoTime(time),
    error,
  };
}

/**
 * A time of Windows, in 100 ns after 1601, in ms after 1970.
 * @param {number} ticks
 */
function windowsTime(ticks) {
  return Math.floor(ticks / 10_000) - 11_644_473_600_000;
}

/**
 * Reads the headers of RAR4.
 * @param {import("@rfetch/lib/ranged").RangedFile} file
 * @param {Cursor} cursor
 */
async function rar4(file, cursor) {
  /** @type {RarFile[]} */
  const files = [];
  let offset = RAR4.length;
  while (true) {
    const prefix = await cursor.bytes(offset, 7);
    if (prefix.length === 0) break;
    if (prefix.length < 7) {
      throw new ArchiveError("rar: unexpected end of file");
    }
    const start = new Fields(prefix);
    const crc = start.u16();
    const type = start.u8();
    const flags = start.u16();
    const size = start.u16();
    if (size < 7) throw new ArchiveError(FORMAT_ERROR);
    const header = await cursor.exact(offset, size);
    if ((crc32(header.subarray(2)) & 0xffff) !== crc) {
      throw new ArchiveError("rar: header CRC error");
    }
    const fields = new Fields(header, 7);
    let dataSize = flags & 0x8000 ? fields.u32() : 0;

    if (type === 0x73 && flags & 0x0080) {
      throw new ArchiveError(
        "rar: an archive with a password on its headers is not supported",
        501,
      );
    }
    if (type === 0x7b) break;
    if (type === 0x74) {
      if (files.length >= MAX_FILES) {
        throw new ArchiveError(`rar: more than ${MAX_FILES} files`, 501);
      }
      const item = rar4File(header, flags, offset + size);
      dataSize = item.packed;
      if (!(flags & 0x0001)) files.push(item);
    }
    offset += size + dataSize;
  }
  return entriesOf(file, files);
}

/**
 * A file of RAR4.
 * @param {Uint8Array} header
 * @param {number} flags
 * @param {number} data
 * @returns {RarFile}
 */
function rar4File(header, flags, data) {
  const fields = new Fields(header, 7);
  let packed = fields.u32();
  let size = fields.u32();
  fields.u8(); // The system of the archiver.
  const crc = fields.u32();
  const dosTime = fields.u32();
  fields.u8(); // The version of RAR to extract the file.
  const method = fields.u8();
  const nameSize = fields.u16();
  fields.u32(); // The attributes.
  if (flags & 0x0100) {
    packed += fields.u32() * 2 ** 32;
    size += fields.u32() * 2 ** 32;
  }
  const name = rar4Name(fields.take(nameSize), Boolean(flags & 0x0200));
  if (flags & 0x0400) fields.take(8); // The salt of the password.
  let time = dosToUtc(dosTime);
  if (flags & 0x1000 && fields.offset + 2 <= header.length) {
    // The extended times: the 4 bits of the time of the last change are
    // first. The bit 4 adds 1 s to the MS-DOS time, which has 2 s.
    const mode = fields.u16() >> 12;
    if (mode & 0x8 && mode & 0x4) time += 1000;
  }

  const isDir = (flags & 0x00e0) === 0x00e0;
  let error = null;
  if (flags & 0x0004) error = "rar: a file with a password is not supported";
  else if (flags & 0x0002) {
    error = "rar: a file in more than one volume is not supported";
  } else if (method !== 0x30 && !isDir) {
    error = "rar: a compressed file is not supported";
  } else if (packed !== size && !isDir) error = FORMAT_ERROR;
  return {
    name: name.replaceAll("\\", "/"),
    isDir,
    size,
    packed,
    data,
    crc,
    modTime: isoTime(time),
    error,
  };
}

/**
 * An MS-DOS time, as UTC, in ms. RAR4 keeps the local time of the computer
 * that made the archive: as for zip, rfetch reads it as UTC.
 * @param {number} value
 */
function dosToUtc(value) {
  const date = value >>> 16;
  const time = value & 0xffff;
  return Date.UTC(
    1980 + (date >> 9),
    ((date >> 5) & 0xf) - 1,
    date & 0x1f,
    time >> 11,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}

/**
 * The name of a file of RAR4. A Unicode name is the name in the code page
 * of the system, a NUL, then the Unicode name in the encoding of RAR. A
 * Unicode name with no NUL is UTF-8.
 * @param {Uint8Array} bytes
 * @param {boolean} unicode
 */
function rar4Name(bytes, unicode) {
  const nul = bytes.indexOf(0);
  if (!unicode || nul === -1) {
    return decoder.decode(nul === -1 ? bytes : bytes.subarray(0, nul));
  }
  const plain = bytes.subarray(0, nul);
  const encoded = bytes.subarray(nul + 1);
  /** @type {number[]} */
  const units = [];
  let position = 0;
  const high = encoded[position++] ?? 0;
  let flags = 0;
  let bits = 0;
  while (position < encoded.length) {
    if (bits === 0) {
      flags = encoded[position++];
      bits = 8;
    }
    switch (flags >> 6) {
      case 0:
        if (position >= encoded.length) break;
        units.push(encoded[position++]);
        break;
      case 1:
        if (position >= encoded.length) break;
        units.push(encoded[position++] + (high << 8));
        break;
      case 2:
        if (position + 1 >= encoded.length) break;
        units.push(encoded[position] + (encoded[position + 1] << 8));
        position += 2;
        break;
      case 3: {
        if (position >= encoded.length) break;
        let length = encoded[position++];
        if (length & 0x80) {
          if (position >= encoded.length) break;
          const correction = encoded[position++];
          for (length = (length & 0x7f) + 2; length > 0; length--) {
            if (units.length >= plain.length) break;
            units.push(
              ((plain[units.length] + correction) & 0xff) + (high << 8),
            );
          }
        } else {
          for (length += 2; length > 0; length--) {
            if (units.length >= plain.length) break;
            units.push(plain[units.length]);
          }
        }
        break;
      }
    }
    flags = (flags << 2) & 0xff;
    bits -= 2;
  }
  return String.fromCharCode(...units);
}
