/**
 * Formats of numbers for people: a size in bytes and a duration, and the
 * sizes and the counts of the lists of rclone.
 *
 * They give the same text as `format` of `@std/fmt/bytes` and of
 * `@std/fmt/duration` for the options that rfetch uses, but with `KiB` in
 * place of `kiB`: the symbol of IEC 80000-13, as rclone writes it.
 */

/** The first letters of the units above the byte. */
const PREFIXES = "kMGTPEZY";

/**
 * Formats a size in bytes, for example `1.5 kB`, or `1.46 KiB` with `binary`.
 * The number has 3 significant digits, and a size of less than 1 byte has no
 * unit prefix.
 * @param {number} bytes
 * @param {{ binary?: boolean, locale?: boolean }} [options] `binary` uses
 *   units of 1024 (KiB, MiB, ...) in place of 1000 (kB, MB, ...). `locale`
 *   writes the number in the format of the locale of the runtime.
 * @returns {string}
 */
export function formatBytes(bytes, { binary = false, locale = false } = {}) {
  if (!Number.isFinite(bytes)) {
    throw new TypeError(
      `Expected a finite number, got ${typeof bytes}: ${bytes}`,
    );
  }
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  const text = (number) =>
    locale ? localeFormat().format(number) : number.toString();
  if (value < 1) {
    return `${sign}${text(value)} B`;
  }

  const exponent = Math.min(
    Math.floor(
      binary ? Math.log(value) / Math.log(1024) : Math.log10(value) / 3,
    ),
    PREFIXES.length,
  );
  value /= Math.pow(binary ? 1024 : 1000, exponent);
  const number = text(Number(value.toPrecision(3)));
  return `${sign}${number} ${unit(exponent, binary)}`;
}

/** @type {Intl.NumberFormat | undefined} */
let numberFormat;

/**
 * Gives the format of numbers of the locale of the runtime. It gives the
 * same text as `toLocaleString()`, which makes a new format for each call.
 */
function localeFormat() {
  numberFormat ??= new Intl.NumberFormat();
  return numberFormat;
}

/**
 * Gives the unit of a power of 1000 or of 1024: B, kB, MB, ... or B, KiB,
 * MiB, ...
 * @param {number} exponent
 * @param {boolean} binary
 * @returns {string}
 */
function unit(exponent, binary) {
  if (exponent === 0) {
    return "B";
  }
  const prefix = PREFIXES[exponent - 1];
  return binary ? `${prefix === "k" ? "K" : prefix}iB` : `${prefix}B`;
}

/**
 * Formats a duration in milliseconds with the units that are not zero, from
 * days to nanoseconds, for example `1m 5s 300ms`.
 * @param {number} milliseconds
 * @returns {string}
 */
export function formatDuration(milliseconds) {
  const ms = Math.abs(milliseconds);
  // The digits of the microseconds and of the nanoseconds.
  const fraction = ms.toFixed(7).slice(-7, -1);
  const parts = [
    [Math.trunc(ms / 86400000), "d"],
    [Math.trunc(ms / 3600000) % 24, "h"],
    [Math.trunc(ms / 60000) % 60, "m"],
    [Math.trunc(ms / 1000) % 60, "s"],
    [Math.trunc(ms) % 1000, "ms"],
    [Number(fraction.slice(0, 3)), "µs"],
    [Number(fraction.slice(3, 6)), "ns"],
  ];
  return parts.filter(([value]) => value).map(([value, unit]) =>
    `${value}${unit}`
  )
    .join(" ");
}

/** The suffixes of the sizes of rclone: powers of 1024. */
const SIZE_SUFFIXES = ["", "Ki", "Mi", "Gi", "Ti", "Pi", "Ei"];

/** The suffixes of the counts of rclone: powers of 1000. */
const COUNT_SUFFIXES = ["", "k", "M", "G", "T", "P", "E"];

/**
 * Writes a number that is 0 or more with the suffix of a power of `base`, as
 * `SizeSuffix` and `CountSuffix` of rclone: with no digit after the point
 * when the number is whole, else with 3 digits. The rounding is the rounding
 * of `%.3f` of Go: to the nearest, and to the even digit for a half.
 * @param {number} value
 * @param {number} base
 * @param {string[]} suffixes
 * @returns {string}
 */
function suffixed(value, base, suffixes) {
  const number = BigInt(value);
  const step = BigInt(base);
  let divisor = 1n;
  let exponent = 0;
  while (exponent < suffixes.length - 1 && number >= divisor * step) {
    divisor *= step;
    exponent++;
  }
  const suffix = suffixes[exponent];
  if (number % divisor === 0n) return `${number / divisor}${suffix}`;
  let thousandths = number * 1000n / divisor;
  const rest = number * 1000n % divisor * 2n;
  if (rest > divisor || (rest === divisor && thousandths % 2n === 1n)) {
    thousandths++;
  }
  const fraction = `${thousandths % 1000n}`.padStart(3, "0");
  return `${thousandths / 1000n}.${fraction}${suffix}`;
}

/**
 * Writes a size in bytes as the lists of rclone: the number, or with
 * `humanReadable` the number with a suffix of a power of 1024, for example
 * `120.562Ki`, as the flag `--human-readable` of rclone.
 * @param {number} size A whole number of bytes, or -1 for no size.
 * @param {boolean} [humanReadable]
 * @returns {string}
 */
export function sizeString(size, humanReadable = false) {
  if (!humanReadable) return `${size}`;
  if (size < 0) return `-${suffixed(-size, 1024, SIZE_SUFFIXES)}`;
  return suffixed(size, 1024, SIZE_SUFFIXES);
}

/**
 * Writes a count of items as the lists of rclone: the number, or with
 * `humanReadable` the number with a suffix of a power of 1000, for example
 * `1.235M`.
 * @param {number} count A whole number, or -1 for no count.
 * @param {boolean} [humanReadable]
 * @returns {string}
 */
export function countString(count, humanReadable = false) {
  if (!humanReadable) return `${count}`;
  if (count < 0) return `-${suffixed(-count, 1000, COUNT_SUFFIXES)}`;
  return suffixed(count, 1000, COUNT_SUFFIXES);
}

/**
 * Writes a size in a field of fixed width, as `SizeStringField` of rclone:
 * on the right of `width` characters, or of 9 with `humanReadable`.
 * @param {number} size
 * @param {boolean} humanReadable
 * @param {number} width
 * @returns {string}
 */
export function sizeField(size, humanReadable, width) {
  return sizeString(size, humanReadable).padStart(humanReadable ? 9 : width);
}

/**
 * Writes a count in a field of fixed width, as `CountStringField` of rclone:
 * on the right of `width` characters, or of 8 with `humanReadable`.
 * @param {number} count
 * @param {boolean} humanReadable
 * @param {number} width
 * @returns {string}
 */
export function countField(count, humanReadable, width) {
  return countString(count, humanReadable).padStart(humanReadable ? 8 : width);
}
