/** The multipliers of the suffixes of a size, as rclone reads them. */
const SYMBOLS = {
  k: 2 ** 10,
  m: 2 ** 20,
  g: 2 ** 30,
  t: 2 ** 40,
  p: 2 ** 50,
  e: 2 ** 60,
};

/**
 * Reads a size as `SizeSuffix.Set` of rclone: a number with an optional
 * suffix of 1024 (k), 1024² (M), and so on to E, with an optional "i" and
 * "B" after it. A number with no suffix is in KiB, and "b" or "B" is a size
 * in bytes. "off" is -1.
 * @param {string} text For example `10M`, `2Gi`, `100KiB` or `4096b`.
 * @returns {number} The size in bytes.
 * @throws {RangeError} For a text that rclone does not accept.
 */
export function parseSize(text) {
  if (text === "") throw new RangeError("Size: empty string.");
  if (text.toLowerCase() === "off") return -1;

  let suffix = text.at(-1);
  let suffixLength = 1;
  let multiplier;
  if (/[0-9.]/.test(suffix)) {
    suffixLength = 0;
    multiplier = SYMBOLS.k;
  } else if (suffix === "b" || suffix === "B") {
    if (text.length > 2 && text.at(-2) === "i") {
      suffix = text.at(-3);
      suffixLength = 3;
      multiplier = SYMBOLS[suffix.toLowerCase()];
    } else {
      multiplier = 1;
    }
  } else if (suffix === "i" || suffix === "I") {
    if (text.length > 1) {
      suffix = text.at(-2);
      suffixLength = 2;
      multiplier = SYMBOLS[suffix.toLowerCase()];
    }
  } else {
    multiplier = SYMBOLS[suffix.toLowerCase()];
  }
  if (!multiplier) {
    throw new RangeError(`Size: bad suffix ${JSON.stringify(suffix)}.`);
  }

  const number = text.slice(0, text.length - suffixLength);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(number)) {
    throw new RangeError(`Size: ${JSON.stringify(text)} is not a number.`);
  }
  const value = Number(number);
  if (value < 0) {
    throw new RangeError(`Size: ${JSON.stringify(text)} is negative.`);
  }
  return Math.trunc(value * multiplier);
}
