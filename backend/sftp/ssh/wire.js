/**
 * The data types of SSH, as RFC 4251 section 5: `byte`, `boolean`,
 * `uint32`, `uint64`, `string`, `mpint` and `name-list`.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** An error in the data of the other side. */
export class ProtocolError extends Error {}

/** Writes the data of a message. */
export class Writer {
  /** @type {Uint8Array} */
  #bytes;
  #length = 0;

  /** @param {number} [size] The number of bytes that the writer can get. */
  constructor(size = 256) {
    this.#bytes = new Uint8Array(size);
  }

  /** @param {number} size The number of bytes to add. */
  #grow(size) {
    if (this.#length + size <= this.#bytes.length) return;
    const bytes = new Uint8Array(
      Math.max(this.#bytes.length * 2, this.#length + size),
    );
    bytes.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = bytes;
  }

  /** @param {number} value */
  byte(value) {
    this.#grow(1);
    this.#bytes[this.#length++] = value;
    return this;
  }

  /** @param {boolean} value */
  boolean(value) {
    return this.byte(value ? 1 : 0);
  }

  /** @param {number} value */
  uint32(value) {
    this.#grow(4);
    new DataView(this.#bytes.buffer).setUint32(this.#length, value);
    this.#length += 4;
    return this;
  }

  /** @param {bigint | number} value */
  uint64(value) {
    this.#grow(8);
    new DataView(this.#bytes.buffer).setBigUint64(this.#length, BigInt(value));
    this.#length += 8;
    return this;
  }

  /**
   * Adds bytes with no length before them.
   * @param {Uint8Array} bytes
   */
  raw(bytes) {
    this.#grow(bytes.length);
    this.#bytes.set(bytes, this.#length);
    this.#length += bytes.length;
    return this;
  }

  /**
   * Adds a `string`: its length, then its bytes. A JavaScript string is
   * UTF-8.
   * @param {Uint8Array | string} value
   */
  string(value) {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    return this.uint32(bytes.length).raw(bytes);
  }

  /**
   * Adds an `mpint`: a number in two's complement, big-endian, with no
   * byte that is not necessary.
   * @param {bigint | Uint8Array} value A number, or the bytes of a number
   *   that is not negative, big-endian.
   */
  mpint(value) {
    return this.string(mpintBytes(value));
  }

  /** @param {string[]} names */
  nameList(names) {
    return this.string(names.join(","));
  }

  /** The bytes that this writer has. */
  bytes() {
    return this.#bytes.slice(0, this.#length);
  }
}

/**
 * The bytes of an `mpint`, with no length.
 * @param {bigint | Uint8Array} value
 * @returns {Uint8Array}
 */
export function mpintBytes(value) {
  let bytes;
  if (typeof value === "bigint") {
    if (value < 0n) throw new RangeError("A negative mpint is not supported");
    if (value === 0n) return new Uint8Array(0);
    let hex = value.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    bytes = Uint8Array.from(
      { length: hex.length / 2 },
      (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16),
    );
  } else {
    let start = 0;
    while (start < value.length && value[start] === 0) start++;
    bytes = value.subarray(start);
  }
  // A number with its high bit set gets a 0 byte before it: else it is
  // negative.
  if (bytes.length && bytes[0] & 0x80) {
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes, 1);
    return padded;
  }
  return bytes;
}

/** Reads the data of a message. */
export class Reader {
  #bytes;
  #view;
  #offset = 0;

  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  }

  /** @param {number} size */
  #need(size) {
    if (this.#offset + size > this.#bytes.length) {
      throw new ProtocolError("The message is too short");
    }
  }

  /** The number of bytes that are not read. */
  get remaining() {
    return this.#bytes.length - this.#offset;
  }

  byte() {
    this.#need(1);
    return this.#bytes[this.#offset++];
  }

  boolean() {
    return this.byte() !== 0;
  }

  uint32() {
    this.#need(4);
    const value = this.#view.getUint32(this.#offset);
    this.#offset += 4;
    return value;
  }

  uint64() {
    this.#need(8);
    const value = this.#view.getBigUint64(this.#offset);
    this.#offset += 8;
    return value;
  }

  /**
   * Reads bytes with no length before them.
   * @param {number} size
   */
  raw(size) {
    this.#need(size);
    const bytes = this.#bytes.subarray(this.#offset, this.#offset + size);
    this.#offset += size;
    return bytes;
  }

  /** Reads a `string` as bytes. */
  bytes() {
    return this.raw(this.uint32());
  }

  /** Reads a `string` as UTF-8 text. */
  string() {
    try {
      return decoder.decode(this.bytes());
    } catch {
      throw new ProtocolError("A string is not UTF-8");
    }
  }

  /** Reads an `mpint` that is not negative. */
  mpint() {
    const bytes = this.bytes();
    if (bytes.length && bytes[0] & 0x80) {
      throw new ProtocolError("A negative mpint is not supported");
    }
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return value;
  }

  nameList() {
    const text = this.string();
    return text === "" ? [] : text.split(",");
  }

  /** The bytes that are not read. */
  rest() {
    return this.raw(this.remaining);
  }
}

/**
 * Tells if two arrays of bytes are equal, in a time that does not depend on
 * where they differ.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/**
 * Joins arrays of bytes.
 * @param {Uint8Array[]} parts
 */
export function concat(...parts) {
  const bytes = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
