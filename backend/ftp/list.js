/**
 * Reads the lines of the lists of FTP: MLSD and MLST of RFC 3659, and LIST,
 * which has the form of `ls -l` on Unix, or the form of MS-DOS.
 */

/**
 * An entry of a list.
 * @typedef {Object} Item
 * @property {string} name
 * @property {"file" | "dir" | "link"} type
 * @property {number} size -1 when the server does not give it.
 * @property {string} modTime The time in ISO 8601, to the second, or ""
 *   when the server does not give an exact time.
 * @property {string} [target] The target of a link of LIST.
 */

/**
 * Reads a line of MLSD or of MLST: facts, a space and the name.
 * @param {string} line For example
 *   `type=file;size=3;modify=20121127181505; a.txt`.
 * @returns {Item | null} null for `.`, `..` and a line that is not correct.
 */
export function parseMLSD(line) {
  // MLST gives a space before the facts.
  const text = line.replace(/^ /, "");
  const space = text.indexOf(" ");
  if (space === -1) return null;
  const name = text.slice(space + 1);
  /** @type {Record<string, string>} */
  const facts = {};
  for (const fact of text.slice(0, space).split(";")) {
    const equal = fact.indexOf("=");
    if (equal > 0) {
      facts[fact.slice(0, equal).toLowerCase()] = fact.slice(equal + 1);
    }
  }
  const type = (facts.type ?? "").toLowerCase();
  if (type === "cdir" || type === "pdir" || name === "." || name === "..") {
    return null;
  }
  /** @type {Item["type"]} */
  let kind = "file";
  if (type === "dir") kind = "dir";
  else if (/^os\.unix=s(?:ym)?link/.test(type)) kind = "link";
  else if (type !== "file" && type !== "") return null;
  const size = facts.size ?? facts.sizd ?? "";
  return {
    name,
    type: kind,
    size: kind !== "dir" && /^\d+$/.test(size) ? Number(size) : -1,
    modTime: parseTime(facts.modify ?? ""),
  };
}

/**
 * Reads a time of MLSD or of MDTM: `YYYYMMDDHHMMSS`, with an optional part
 * of a second, in UTC.
 * @param {string} text
 * @returns {string} The time in ISO 8601 to the second, or "".
 */
export function parseTime(text) {
  const match = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.\d+)?$/.exec(text);
  if (!match) return "";
  const [, year, month, day, hour, minute, second] = match;
  const time = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (Number.isNaN(time)) return "";
  // A list with a precision of 1 s has no part of a second.
  return new Date(time).toISOString().replace(/\.000Z$/, "Z");
}

/** A line of `ls -l`: the type and the permissions, then the fields. */
const UNIX = /^([-dlbcpsD])[-rwxsStTlL+.@]{9}\S*\s+(.*)$/;

/** The date of `ls -l`: a month, a day, and a time or a year. */
const UNIX_DATE =
  /^(?:(\S+)\s+)*?(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}:\d\d|\d{4})\s(.*)$/;

/** A line of MS-DOS: `01-02-23  03:04PM  <DIR>  name`. */
const DOS =
  /^(\d\d)-(\d\d)-(\d\d(?:\d\d)?)\s+(\d\d):(\d\d)([AP]M)?\s+(<DIR>|\d+)\s+(.+)$/i;

/**
 * Reads a line of LIST. The times of LIST are not exact, for example with
 * no second or no year: the item has no time.
 * @param {string} line
 * @returns {Item | null} null for `.`, `..`, a total and a line that is not
 *   correct.
 */
export function parseLIST(line) {
  const unix = UNIX.exec(line);
  if (unix) {
    const [, letter, rest] = unix;
    // The fields before the date: links, user, group and size. The size is
    // the last number before the month.
    const date = UNIX_DATE.exec(rest);
    if (!date) return null;
    const size = Number(date[2]);
    let name = date[6];
    /** @type {Item["type"]} */
    let type = "file";
    /** @type {string | undefined} */
    let target;
    if (letter === "d") type = "dir";
    else if (letter === "l") {
      type = "link";
      const arrow = name.indexOf(" -> ");
      if (arrow !== -1) {
        target = name.slice(arrow + 4);
        name = name.slice(0, arrow);
      }
    } else if (letter !== "-") return null;
    if (name === "." || name === "..") return null;
    return {
      name,
      type,
      size: type === "dir" ? -1 : size,
      modTime: "",
      ...(target === undefined ? {} : { target }),
    };
  }
  const dos = DOS.exec(line);
  if (dos) {
    const name = dos[8];
    if (name === "." || name === "..") return null;
    const folder = dos[7].toUpperCase() === "<DIR>";
    return {
      name,
      type: folder ? "dir" : "file",
      size: folder ? -1 : Number(dos[7]),
      modTime: "",
    };
  }
  return null;
}
