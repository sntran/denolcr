/**
 * Formats of numbers for people: a size in bytes and a duration.
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
  const text = (number) => locale ? number.toLocaleString() : number.toString();
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
