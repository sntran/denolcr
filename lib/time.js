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
