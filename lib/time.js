/**
 * Writes a time as the ModTime of `rclone lsjson` for a remote with a
 * precision of 1 ms: the format `2006-01-02T15:04:05.000Z07:00` of Go, in the
 * local time zone. The time zone is `Z` for UTC, else `+hh:mm` or `-hh:mm`.
 * @param {string | number | Date | null | undefined} value
 * @param {number} [offset] The minutes after UTC of the time zone. By
 *   default, the offset of the local time zone at that time.
 * @returns {string | undefined} No string for no time, or for a time that is
 *   not correct.
 */
export function toLocaleISOString(value, offset) {
  if (value === null || value === undefined || value === "") return undefined;
  const date = new Date(value);
  if (isNaN(date.getTime())) return undefined;

  offset ??= -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60000).toISOString()
    .slice(0, -1);
  if (offset === 0) return `${local}Z`;
  const minutes = Math.abs(offset);
  const pad = (number) => String(number).padStart(2, "0");
  return `${local}${offset < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}:${
    pad(minutes % 60)
  }`;
}
