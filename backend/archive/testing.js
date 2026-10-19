/**
 * Writes zip files for the tests, with the parts that the tests need: the
 * methods Store and Deflate, ZIP64, data before the zip file, extra fields,
 * and flags. The tests also use files of the command `zip`.
 */
import * as zlib from "node:zlib";

import { crc32 } from "@rfetch/lib/crc32";

const encoder = new TextEncoder();

/**
 * A file or a folder of a zip file for the tests.
 * @typedef {Object} ZipFile
 * @property {string} name With a "/" at the end for a folder.
 * @property {Uint8Array | string} [data]
 * @property {number} [method] 0 for Store, 8 for Deflate (the default), or
 *   another method for a test of an error.
 * @property {Date} [time] The MS-DOS time, in UTC.
 * @property {number} [flags]
 * @property {number} [crc] A CRC-32 that is not correct, for a test.
 * @property {Uint8Array} [extra] The extra fields of the index.
 */

/** Writes numbers in little endian. */
class Writer {
  /** @type {number[]} */
  bytes = [];

  /** @param {number} value */
  u16(value) {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }

  /** @param {number} value */
  u32(value) {
    this.u16(value & 0xffff).u16(Math.floor(value / 0x10000) & 0xffff);
    return this;
  }

  /** @param {number} value */
  u64(value) {
    return this.u32(value % 2 ** 32).u32(Math.floor(value / 2 ** 32));
  }

  /** @param {Uint8Array} bytes */
  add(bytes) {
    for (const byte of bytes) this.bytes.push(byte);
    return this;
  }
}

/**
 * An extra field.
 * @param {number} tag
 * @param {Uint8Array} data
 */
export function extraField(tag, data) {
  return Uint8Array.from(
    new Writer().u16(tag).u16(data.length).add(data).bytes,
  );
}

/**
 * The extended timestamp field, with the time of the last change.
 * @param {Date} time
 */
export function extendedTime(time) {
  return extraField(
    0x5455,
    Uint8Array.from(
      new Writer().add([1]).u32(Math.floor(time.getTime() / 1000)).bytes,
    ),
  );
}

/**
 * The NTFS field, with the time of the last change in 100 ns.
 * @param {bigint} ticks After 1601.
 */
export function ntfsTime(ticks) {
  const data = new Uint8Array(32);
  const view = new DataView(data.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, 24, true);
  view.setBigUint64(8, ticks, true);
  return extraField(0x000a, data);
}

/**
 * Writes a zip file.
 * @param {ZipFile[]} files
 * @param {{ zip64?: boolean, prefix?: Uint8Array, comment?: string }} [options]
 *   `zip64` writes all the sizes and the offsets in ZIP64 fields. `prefix`
 *   goes before the zip file, with the offsets from the start of the zip
 *   file, as a program that extracts the files.
 * @returns {Uint8Array}
 */
export function zipFile(files, { zip64 = false, prefix, comment = "" } = {}) {
  const out = new Writer();
  const central = new Writer();
  const max32 = 0xffffffff;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === "string"
      ? encoder.encode(file.data)
      : file.data ?? new Uint8Array(0);
    const method = file.method ?? (file.name.endsWith("/") ? 0 : 8);
    const packed = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = file.crc ?? crc32(data);
    const time = file.time ?? new Date(Date.UTC(2024, 4, 6, 7, 8, 10));
    const dosTime = time.getUTCHours() << 11 | time.getUTCMinutes() << 5 |
      time.getUTCSeconds() >> 1;
    const dosDate = (time.getUTCFullYear() - 1980) << 9 |
      (time.getUTCMonth() + 1) << 5 | time.getUTCDate();
    const flags = file.flags ?? 0x800;
    const offset = out.bytes.length;
    const sizes = zip64
      ? Uint8Array.from(new Writer().u64(data.length).u64(packed.length).bytes)
      : new Uint8Array(0);
    const localExtra = zip64 ? extraField(0x0001, sizes) : new Uint8Array(0);

    out.u32(0x04034b50).u16(zip64 ? 45 : 20).u16(flags).u16(method)
      .u16(dosTime).u16(dosDate).u32(crc)
      .u32(zip64 ? max32 : packed.length).u32(zip64 ? max32 : data.length)
      .u16(name.length).u16(localExtra.length).add(name).add(localExtra)
      .add(packed);

    const extras = [
      ...(zip64
        ? [extraField(
          0x0001,
          Uint8Array.from(
            new Writer().u64(data.length).u64(packed.length).u64(offset).bytes,
          ),
        )]
        : []),
      ...(file.extra ? [file.extra] : []),
    ];
    const extra = Uint8Array.from(extras.flatMap((part) => [...part]));
    central.u32(0x02014b50).u16(0x031e).u16(zip64 ? 45 : 20).u16(flags)
      .u16(method).u16(dosTime).u16(dosDate).u32(crc)
      .u32(zip64 ? max32 : packed.length).u32(zip64 ? max32 : data.length)
      .u16(name.length).u16(extra.length).u16(0).u16(0).u16(0).u32(0)
      .u32(zip64 ? max32 : offset).add(name).add(extra);
  }
  const indexOffset = out.bytes.length;
  out.add(central.bytes);
  const indexSize = central.bytes.length;
  const commentBytes = encoder.encode(comment);
  if (zip64) {
    const end64 = out.bytes.length;
    out.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0)
      .u64(files.length).u64(files.length).u64(indexSize).u64(indexOffset);
    out.u32(0x07064b50).u32(0).u64(end64).u32(1);
    out.u32(0x06054b50).u16(0).u16(0).u16(0xffff).u16(0xffff).u32(max32)
      .u32(max32).u16(commentBytes.length).add(commentBytes);
  } else {
    out.u32(0x06054b50).u16(0).u16(0).u16(files.length).u16(files.length)
      .u32(indexSize).u32(indexOffset).u16(commentBytes.length)
      .add(commentBytes);
  }
  const zip = Uint8Array.from(out.bytes);
  if (!prefix) return zip;
  const all = new Uint8Array(prefix.length + zip.length);
  all.set(prefix);
  all.set(zip, prefix.length);
  return all;
}
