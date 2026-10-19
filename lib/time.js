/**
 * Writes a time as the ModTime of `rclone lsjson`, in the local time zone:
 * the format `2006-01-02T15:04:05.000000000Z07:00` of Go, with the digits
 * after the second of the remote. The time zone is `Z` for UTC, else
 * `+hh:mm` or `-hh:mm`.
 *
 * As rclone, the number of digits after the second tells the precision of
 * the remote: 9 for 1 ns, for example a local file, 3 for 1 ms, and none for
 * 1 s, for example the http backend. A time in a string keeps its digits,
 * from 0 to 9. A Date or a number has 3.
 * @param {string | number | Date | null | undefined} value
 * @param {number} [offset] The minutes after UTC of the time zone. By
 *   default, the offset of the local time zone at that time.
 * @returns {string | undefined} No string for no time, or for a time that is
 *   not correct.
 */
export function toLocaleISOString(value, offset) {
  if (value === null || value === undefined || value === "") return undefined;
  /** The digits after the second of a string, or undefined for 3. */
  let digits;
  if (typeof value === "string") {
    const match = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/i
      .exec(value);
    if (match) {
      digits = (match[2] ?? "").slice(0, 9);
      value = `${match[1]}.${digits.slice(0, 3).padEnd(3, "0")}${match[3]}`;
    }
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) return undefined;

  offset ??= -date.getTimezoneOffset();
  let local = new Date(date.getTime() + offset * 60000).toISOString()
    .slice(0, -1);
  // The time zone does not change the digits after the second.
  if (digits !== undefined) {
    local = local.slice(0, -4) + (digits ? `.${digits}` : "");
  }
  if (offset === 0) return `${local}Z`;
  const minutes = Math.abs(offset);
  const pad = (number) => String(number).padStart(2, "0");
  return `${local}${offset < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}:${
    pad(minutes % 60)
  }`;
}

/**
 * The nanoseconds after 1970 of a time, with all the digits after the
 * second, from 0 to 9: `Date.parse` keeps only 3.
 * @param {string | null | undefined} value A time in ISO 8601, or another
 *   time that `Date.parse` reads, for example `Last-Modified`.
 * @returns {bigint | undefined} No number for no time, or for a time that
 *   is not correct.
 */
export function nanosecondsOf(value) {
  if (!value) return undefined;
  const match = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/i
    .exec(value);
  const milliseconds = Date.parse(match ? `${match[1]}${match[3]}` : value);
  if (Number.isNaN(milliseconds)) return undefined;
  const fraction = (match?.[2] ?? "").slice(0, 9).padEnd(9, "0");
  return BigInt(milliseconds) * 1_000_000n + BigInt(fraction);
}

/**
 * The time of a folder that has no time, as the default of the flag
 * `--default-time` of rclone.
 */
export const DEFAULT_TIME = "2000-01-01T00:00:00Z";

/**
 * Writes a time as the lists of rclone, in the local time zone: the format
 * `2006-01-02 15:04:05` of Go, for example for `rclone lsd` and `rclone lsf`,
 * with `digits` digits after the second, for example 9 for `rclone lsl`.
 * @param {string | number | Date | null | undefined} value
 * @param {number} [digits]
 * @returns {string} For no time, the zero time of Go, as rclone.
 */
export function toListTime(value, digits = 0) {
  const iso = toLocaleISOString(value) ?? "0001-01-01T00:00:00Z";
  const [, day, time, fraction = ""] =
    /^(.+)T(\d\d:\d\d:\d\d)(?:\.(\d+))?/.exec(iso) ?? [];
  if (!digits) return `${day} ${time}`;
  return `${day} ${time}.${fraction.padEnd(digits, "0").slice(0, digits)}`;
}

/**
 * Reads a time in seconds after 1970, with an optional part of a second, for
 * example `1354040105` or `1354040105.123456789`. This is the format of the
 * header `X-OC-Mtime` of ownCloud, which rclone sends to a WebDAV server, and
 * of the metadata `mtime` that rclone keeps on S3 and Swift. The digits after
 * the ninth digit of the part of a second are cut.
 * @param {string | null | undefined} value
 * @returns {bigint | undefined} The nanoseconds after 1970, or no number for
 *   a value that is not correct.
 */
export function parseUnixTime(value) {
  const match = /^(-?)(\d{1,15})(?:\.(\d{1,9})\d*)?$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const nanoseconds = BigInt(match[2]) * 1_000_000_000n +
    BigInt((match[3] ?? "").padEnd(9, "0"));
  return match[1] ? -nanoseconds : nanoseconds;
}

/**
 * Writes a time in seconds after 1970, as `TimeToFloatString` of rclone: the
 * part of a second has no zeros at its end, and a whole second has no point,
 * for example `1354040105.12345` or `1354040105`.
 * @param {bigint} nanoseconds The nanoseconds after 1970.
 * @returns {string}
 */
export function formatUnixTime(nanoseconds) {
  if (nanoseconds < 0n) return `-${formatUnixTime(-nanoseconds)}`;
  const second = 1_000_000_000n;
  const fraction = String(nanoseconds % second).padStart(9, "0")
    .replace(/0+$/, "");
  return `${nanoseconds / second}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Writes a time in ISO 8601 in UTC, with 9 digits after the second: the
 * format of rclone for a remote with a precision of 1 ns.
 * @param {bigint} nanoseconds The nanoseconds after 1970.
 * @returns {string}
 */
export function isoStringOf(nanoseconds) {
  const second = 1_000_000_000n;
  // The floor, also for a time before 1970.
  let fraction = nanoseconds % second;
  if (fraction < 0n) fraction += second;
  const seconds = (nanoseconds - fraction) / second;
  const date = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${date}.${String(fraction).padStart(9, "0")}Z`;
}

/**
 * The time of the header `X-OC-Mtime` of a request: the time that a `PUT`,
 * a `COPY`, a `MOVE` or a `PATCH` gives to the file.
 * @param {Request} request
 * @returns {bigint | null | undefined} The nanoseconds after 1970, null
 *   when the request has no such header, or no value for a value that is
 *   not correct.
 */
export function modTimeOf(request) {
  const value = request.headers.get("X-OC-Mtime");
  return value === null ? null : parseUnixTime(value);
}
