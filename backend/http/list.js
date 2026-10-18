/**
 * The list options of rclone, as `CommaSepList` and `SpaceSepList` of rclone
 * (fs/config_list.go): one record of the CSV rules of the `encoding/csv`
 * package of Go, with no comments and no lazy quotes.
 */

/**
 * Reads the values of a list option.
 *
 * As in Go, a value in quotes can have the separator, a line break, and `""`
 * for one quote. A value with no quotes cannot have a quote. Empty lines at
 * the start are not a record, and the text after the first record is not a
 * part of the list.
 * @param {string} text For example `Cookie,"a=1, b=2"`.
 * @param {string} [separator] `,` for `CommaSepList`, or ` ` for
 *   `SpaceSepList`.
 * @returns {string[]} For example `["Cookie", "a=1, b=2"]`, or `[]` for an
 *   empty text.
 * @throws {SyntaxError} When a quote is not correct.
 */
export function parseList(text, separator = ",") {
  if (text === "") return [];

  // As the reader of Go, "\r\n" at the end of a line is "\n", and the last
  // line can end with no "\n".
  const lines = text.split(/(?<=\n)/).map((line) =>
    line.endsWith("\r\n") ? `${line.slice(0, -2)}\n` : line
  );
  if (lines.at(-1).endsWith("\r")) lines.push(lines.pop().slice(0, -1));

  let index = 0;
  while (index < lines.length && /^\n?$/.test(lines[index])) index++;
  // As in rclone, a text of only empty lines is an error.
  if (index === lines.length) throw new SyntaxError("EOF");

  /** @type {string[]} */
  const values = [];
  let line = lines[index++];
  for (;;) {
    if (!line.startsWith('"')) {
      // A value with no quotes.
      const end = line.indexOf(separator);
      const value = end === -1 ? line.replace(/\n$/, "") : line.slice(0, end);
      if (value.includes('"')) {
        throw new SyntaxError('bare " in non-quoted-field');
      }
      values.push(value);
      if (end === -1) return values;
      line = line.slice(end + separator.length);
      continue;
    }

    // A value in quotes, on one line or more.
    line = line.slice(1);
    let value = "";
    for (;;) {
      const quote = line.indexOf('"');
      if (quote === -1) {
        value += line;
        if (index === lines.length) {
          throw new SyntaxError('extraneous or missing " in quoted-field');
        }
        line = lines[index++];
        continue;
      }
      value += line.slice(0, quote);
      line = line.slice(quote + 1);
      if (line.startsWith('"')) {
        // `""` is one quote.
        value += '"';
        line = line.slice(1);
      } else if (line.startsWith(separator)) {
        values.push(value);
        line = line.slice(separator.length);
        break;
      } else if (line === "" || line === "\n") {
        values.push(value);
        return values;
      } else {
        throw new SyntaxError('extraneous or missing " in quoted-field');
      }
    }
  }
}
