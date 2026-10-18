/**
 * Writes a time as the ModTime of `rclone lsjson`, in the local time zone:
 * the format `2006-01-02T15:04:05.000000000Z07:00` of Go, with the digits
 * after the second of the remote. The time zone is `Z` for UTC, else
 * `+hh:mm` or `-hh:mm`.
 *
 * As rclone, the number of digits after the second tells the precision of
 * the remote: 9 for 1 ns, for example a local file, and 3 for 1 ms. A time
 * in a string keeps its digits, from 3 to 9. A Date or a number has 3.
 * @param {string | number | Date | null | undefined} value
 * @param {number} [offset] The minutes after UTC of the time zone. By
 *   default, the offset of the local time zone at that time.
 * @returns {string | undefined} No string for no time, or for a time that is
 *   not correct.
 */
export function toLocaleISOString(value, offset) {
  if (value === null || value === undefined || value === "") return undefined;
  /** The digits after the second, when there are more than 3. */
  let digits = "";
  if (typeof value === "string") {
    const match = /^(.*T\d\d:\d\d:\d\d)\.(\d{4,})(Z|[+-]\d\d:\d\d)$/i
      .exec(value);
    if (match) {
      digits = match[2].slice(0, 9);
      value = `${match[1]}.${digits.slice(0, 3)}${match[3]}`;
    }
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) return undefined;

  offset ??= -date.getTimezoneOffset();
  let local = new Date(date.getTime() + offset * 60000).toISOString()
    .slice(0, -1);
  // The time zone does not change the digits after the millisecond.
  if (digits) local = `${local.slice(0, -3)}${digits}`;
  if (offset === 0) return `${local}Z`;
  const minutes = Math.abs(offset);
  const pad = (number) => String(number).padStart(2, "0");
  return `${local}${offset < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}:${
    pad(minutes % 60)
  }`;
}
