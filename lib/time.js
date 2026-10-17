/**
 * Converts a date string to a locale ISO string.
 * @param {string | null} value
 * @returns {string}
 */
export function toLocaleISOString(value) {
  if (!value) return undefined;

  let date = new Date(value);
  const off = date.getTimezoneOffset() * -1;
  const del = date.getMilliseconds() ? "Z" : "."; // have milliseconds ?
  date = new Date(date.getTime() + off * 60000); // add or subtract time zone
  return date
    .toISOString()
    .split(del)[0] +
    (off < 0 ? "-" : "+") +
    ("0" + Math.abs(Math.floor(off / 60))).substring(-2) +
    ":" +
    ("0" + Math.abs(off % 60)).substring(-2);
}
