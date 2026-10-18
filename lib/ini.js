/**
 * The configuration file of rclone, in the INI format of the library goconfig
 * v1.0.0 (github.com/unknwon/goconfig), which rclone uses to read and write
 * the file:
 *
 * ```ini
 * # The comments of the person stay in the file.
 * [remote]
 * type = s3
 * provider = Cloudflare
 *
 * [secret]
 * type = crypt
 * remote = remote:bucket
 * ```
 *
 * The rules of goconfig:
 *
 * - A line ends with "\n". The white space at the two ends of a line goes
 *   away, with the white space of Go: also U+0085 and U+00A0.
 * - An empty line, and a line that starts with `#` or `;` (a comment), give
 *   no key.
 * - `[name]` starts a section. The keys before the first section go in the
 *   section `DEFAULT`. Two sections with the same name become one.
 * - `key = value` and `key: value` set a key. The first `=` or `:` is the
 *   end of the key.
 * - A key in quotes (`` `key` ``, `"key"` or `"""key"""`) keeps its white
 *   space, and can have `=` and `:`.
 * - A value in quotes (`` `value` `` or `"""value"""`) keeps its white space.
 *   The value ends at the last quote of the line.
 * - The key `-` gets a number in its section: `#1`, then `#2`, and so on.
 *
 * `parse` and `read` give the configuration. `ConfigFile` changes the
 * configuration in the text of a file, and keeps the comments.
 */

/** The section of the keys before the first section. */
export const DEFAULT = "DEFAULT";

/** The white space that `strings.TrimSpace` of Go removes. */
const SPACE =
  "[\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]";
const TRIM = new RegExp(`^${SPACE}+|${SPACE}+$`, "g");
const TRIM_START = new RegExp(`^${SPACE}+`);

/** The byte order mark, which goconfig removes at the start of the file. */
const BOM = "\uFEFF";

const encoder = new TextEncoder();

/**
 * An item of a line of a configuration file. An empty line has no entry.
 *
 * - A `section` entry starts a section. The section `[]` has the name "":
 *   goconfig makes it the section DEFAULT, but it cannot have keys.
 * - A `key` entry has a key and its value. `auto` is true for a key `-`.
 *   goconfig ignores the key "", and the key " " only makes the section.
 * - A `comment` entry has the text of the comment, with its `#` or `;`.
 *
 * `section` is the current section of the line, and `line` is the number of
 * the line, from 1.
 * @typedef {{ section: string, line: number } & (
 *   { type: "section" } |
 *   { type: "key", key: string, value: string, auto?: true } |
 *   { type: "comment", text: string }
 * )} Entry
 */

/**
 * A configuration: the keys of each section, in the order of the file.
 * @typedef {Record<string, Record<string, string>>} Config
 */

/**
 * Reads the text of a configuration file.
 * @param {string} text
 * @returns {Config}
 * @throws {SyntaxError} For a line that goconfig does not accept.
 */
export function parse(text) {
  const lines = new LineReader();
  const config = new ConfigBuilder();
  for (const line of text.split("\n")) {
    config.add(lines.read(line));
  }
  return config.value;
}

/**
 * Reads a configuration file from a stream of text, for example the body of
 * a response through a `TextDecoderStream`.
 * @param {ReadableStream<string>} stream
 * @returns {Promise<Config>}
 */
export async function read(stream) {
  const config = new ConfigBuilder();
  for await (const entry of stream.pipeThrough(new ParseStream())) {
    config.add(entry);
  }
  return config.value;
}

/**
 * A stream that reads the text of a configuration file, in chunks of any
 * size, and gives an entry for each line with a section, a key or a comment.
 * It keeps only the part of a line that has no "\n" yet. A line that goconfig
 * does not accept makes an error of the stream.
 * @extends {TransformStream<string, Entry>}
 */
export class ParseStream extends TransformStream {
  constructor() {
    const lines = new LineReader();
    let rest = "";
    super({
      transform(chunk, controller) {
        const parts = (rest + chunk).split("\n");
        rest = parts.pop();
        for (const part of parts) {
          const entry = lines.read(part);
          if (entry) controller.enqueue(entry);
        }
      },
      flush(controller) {
        const entry = lines.read(rest);
        if (entry) controller.enqueue(entry);
      },
    });
  }
}

/**
 * The text of a configuration file, which changes only on the lines of a
 * change. All other lines stay as they are: the comments, the empty lines and
 * the format of each line.
 *
 * A comment directly above a section or a key, with no empty line between,
 * is a comment of that line. It goes away only when that line goes away. All
 * other comments always stay.
 */
export class ConfigFile {
  #bom = false;
  /** @type {Array<{ text: string, entry?: Entry, delimiter: number }>} */
  #lines = [];
  /** "\r" when the lines of the file end with "\r\n". */
  #eol = "";

  /**
   * @param {string} [text] The text of the file.
   * @throws {SyntaxError} For a line that goconfig does not accept.
   */
  constructor(text = "") {
    this.#load(text);
  }

  /** @returns {Config} */
  get config() {
    const config = new ConfigBuilder();
    for (const { entry } of this.#lines) {
      config.add(entry);
    }
    return config.value;
  }

  /** @returns {string} The text of the file. */
  toString() {
    const text = this.#lines.map(({ text }) => text).join("\n");
    // A line that starts with U+FEFF needs a byte order mark before it when
    // it is the first line.
    return this.#bom || text.startsWith(BOM) ? BOM + text : text;
  }

  /**
   * Sets the keys of a section, and makes the section when it does not
   * exist. A key with no value (undefined or null) goes away. The other keys
   * stay.
   * @param {string} name
   * @param {Record<string, unknown>} keys
   * @throws {TypeError} For a name, a key or a value that rclone cannot read
   *   back the same, as `stringify`. Then the file does not change.
   */
  update(name, keys) {
    this.#change(name, keys, false);
  }

  /**
   * Sets the keys of a section as `update`, and removes the other keys of
   * the section.
   * @param {string} name
   * @param {Record<string, unknown>} keys
   * @throws {TypeError} As `update`.
   */
  set(name, keys) {
    this.#change(name, keys, true);
  }

  /**
   * Removes a section: all its lines, and their comments.
   * @param {string} name
   */
  delete(name) {
    const remove = new Set();
    for (const [index, { entry }] of this.#lines.entries()) {
      if (entry && entry.type !== "comment" && sectionOf(entry) === name) {
        remove.add(index);
      }
    }
    if (remove.size) {
      this.#write({ remove });
    }
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} keys
   * @param {boolean} replace True to remove the keys that are not in `keys`.
   */
  #change(name, keys, replace) {
    const lines = this.#lines;
    /** Tells if a line has a key of the section. */
    const isKey = (index) => {
      const entry = lines[index].entry;
      return entry?.type === "key" && sectionOf(entry) === name &&
        entry.key !== "" && entry.key !== " ";
    };

    /** @type {Set<number>} */
    const remove = new Set();
    /** @type {Map<number, string>} The new values of lines. */
    const values = new Map();
    /** @type {string[]} The lines of the new keys. */
    const added = [];

    for (const [key, value] of Object.entries(keys)) {
      const indexes = [...lines.keys()].filter((index) =>
        isKey(index) && lines[index].entry.key === key
      );
      if (value === undefined || value === null) {
        for (const index of indexes) remove.add(index);
      } else if (indexes.length) {
        // The last line of a key gives its value.
        const index = indexes.at(-1);
        withValue(lines[index], `${value}`);
        if (lines[index].entry.value !== `${value}`) {
          values.set(index, `${value}`);
        }
      } else {
        added.push(writeLine(key, `${value}`) + this.#eol);
      }
    }
    if (replace) {
      for (const index of lines.keys()) {
        if (!isKey(index)) continue;
        const { key } = lines[index].entry;
        // Only own keys: the key "toString" is not in `{}`.
        if ((Object.hasOwn(keys, key) ? keys[key] : null) == null) {
          remove.add(index);
        }
      }
    }

    if (!Object.hasOwn(this.config, name)) {
      const header = `[${writeSection(name)}]${this.#eol}`;
      this.#write({ remove, values, section: [header, ...added] });
      return;
    }

    /** @type {Map<number, string[]>} */
    const insert = new Map();
    /** @type {Map<number, string>} */
    const texts = new Map();

    // The new keys go after the last line of the section that stays.
    const after = lines.findLastIndex(({ entry }, index) =>
      entry && entry.type !== "comment" && sectionOf(entry) === name &&
      !(entry.type === "key" && entry.key === "") && !remove.has(index)
    );

    // DEFAULT has no `[DEFAULT]` line when its keys are at the start of the
    // file. When all of them go away, a `[DEFAULT]` line in the place of the
    // first one keeps the place of the section.
    const top = lines.findIndex(({ entry }) => entry?.type === "section");
    const atTop = [...lines.keys()].filter((index) =>
      (top === -1 || index < top) && lines[index].entry?.type === "key" &&
      lines[index].entry.key !== ""
    );
    if (
      name === DEFAULT && atTop.length &&
      atTop.every((index) => remove.has(index))
    ) {
      const header = `[${DEFAULT}]${this.#eol}`;
      insert.set(atTop[0] - 1, after === -1 ? [header, ...added] : [header]);
    }

    if (after !== -1) {
      insert.set(after, added);
      // The section `[]` cannot have keys, but `[DEFAULT]` can.
      const { entry, text } = lines[after];
      if (added.length && entry.type === "section" && entry.section === "") {
        texts.set(after, `[${DEFAULT}]${eolOf(text)}`);
      }
    }

    this.#write({ remove, values, texts, insert });
  }

  /**
   * Writes the new text of the file, and reads it again.
   * @param {object} change
   * @param {Set<number>} change.remove The lines to remove, with their
   *   comments.
   * @param {Map<number, string>} [change.values] The new values of lines.
   * @param {Map<number, string>} [change.texts] The new texts of lines.
   * @param {Map<number, string[]>} [change.insert] The lines to put after a
   *   line, or at the start for -1.
   * @param {string[]} [change.section] A new section for the end.
   */
  #write({
    remove,
    values = new Map(),
    texts = new Map(),
    insert = new Map(),
    section = [],
  }) {
    const lines = this.#lines;

    // A comment directly above a line that goes away goes away too.
    for (const index of [...remove]) {
      for (
        let above = index - 1;
        lines[above]?.entry?.type === "comment";
        above--
      ) {
        remove.add(above);
      }
    }

    // A key `-` gets its number from the keys `-` before it in its part of
    // the section. When one goes away, the keys `-` after it get their
    // number as a key in quotes.
    const explicit = new Set();
    let shift = false;
    for (const [index, { entry }] of lines.entries()) {
      if (entry?.type === "section") shift = false;
      if (entry?.type !== "key" || !entry.auto) continue;
      if (remove.has(index)) shift = true;
      else if (shift) explicit.add(index);
    }

    const result = [...insert.get(-1) ?? []];
    let removed = false;
    for (const [index, line] of lines.entries()) {
      if (!remove.has(index)) {
        // Two empty lines do not come together where lines went away.
        const blank = !line.entry && trim(line.text) === "";
        if (
          !(blank && removed && (!result.length || trim(result.at(-1)) === ""))
        ) {
          result.push(this.#text(index, values, texts, explicit.has(index)));
        }
        removed = false;
      } else {
        removed = true;
      }
      if (insert.get(index)?.length) {
        result.push(...insert.get(index));
        removed = false;
      }
    }

    if (section.length) {
      // The new section goes at the end, before the empty end of the file,
      // after an empty line.
      let end = result.length;
      if (end && result[end - 1] === "") end--;
      if (end && trim(result[end - 1]) !== "") section.unshift(this.#eol);
      result.splice(end, 0, ...section);
    }

    const text = result.join("\n");
    this.#load(this.#bom || text.startsWith(BOM) ? BOM + text : text);
  }

  /**
   * The new text of a line.
   * @param {number} index
   * @param {Map<number, string>} values
   * @param {Map<number, string>} texts
   * @param {boolean} explicit True to write the number of a key `-`.
   */
  #text(index, values, texts, explicit) {
    const line = this.#lines[index];
    const { entry } = line;
    if (explicit) {
      const value = values.get(index) ?? entry.value;
      return writeLine(entry.key, value) + eolOf(line.text);
    }
    if (values.has(index)) {
      return withValue(line, values.get(index));
    }
    return texts.get(index) ?? line.text;
  }

  /** @param {string} text */
  #load(text) {
    this.#bom = text.startsWith(BOM);
    const reader = new LineReader({ bom: false });
    this.#lines = (this.#bom ? text.slice(1) : text).split("\n").map((
      text,
    ) => ({ text, entry: reader.read(text), delimiter: reader.delimiter }));
    this.#eol = this.#lines.some(({ text }) => text.endsWith("\r")) ? "\r" : "";
  }
}

/**
 * Writes a configuration file that rclone reads as the same configuration.
 * The keys of the section `DEFAULT` come first with no `[DEFAULT]` line, when
 * `DEFAULT` is the first section. Then each section comes, with an empty line
 * between the sections, as rclone writes them. A key with no value
 * (undefined or null) is not written. To keep the comments of a file, use
 * `ConfigFile`.
 *
 * A key or a value goes in quotes when rclone does not read it the same with
 * no quotes, for example a value with a space at the start. In some of these
 * cases, rclone writes no quotes, or quotes that it cannot read back.
 * @param {Record<string, Record<string, unknown>>} config
 * @param {{ section?: string }} [options] With a `section`, `config` is the
 *   keys of that one section.
 * @returns {string}
 * @throws {TypeError} For a name, a key or a value that rclone cannot read
 *   back the same: a line break in it, a section name that is empty or has
 *   white space at the start or at the end, and the keys "", " " and "-".
 */
export function stringify(config, { section } = {}) {
  if (section) {
    return stringify({ [section]: config });
  }

  const blocks = [];
  for (const [index, [name, keys]] of Object.entries(config).entries()) {
    if (typeof keys !== "object" || keys === null) {
      throw new TypeError(
        `INI: the section ${JSON.stringify(name)} is not an object.`,
      );
    }
    const lines = Object.entries(keys)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => writeLine(key, `${value}`));

    if (name === DEFAULT && index === 0 && lines.length) {
      blocks.push(lines);
    } else {
      blocks.push([`[${writeSection(name)}]`, ...lines]);
    }
  }
  const text = blocks.map((lines) => lines.join("\n")).join("\n\n");
  // A key that starts with U+FEFF needs a byte order mark before it when it
  // is the first line.
  return text.startsWith(BOM) ? BOM + text : text;
}

/**
 * Reads the lines of one file, one at a time, as `ConfigFile.read` of
 * goconfig. It keeps the current section and the number of the line.
 */
class LineReader {
  #section = DEFAULT;
  /** The number of the next key `-` in the section. */
  #count = 1;
  #number = 0;
  #bom;

  /**
   * The position of the `=` or `:` after the key in the last line, or -1
   * when the last line has no key.
   */
  delimiter = -1;

  /**
   * @param {{ bom?: boolean }} [options] `bom: false` keeps a byte order mark
   *   at the start of the first line.
   */
  constructor({ bom = true } = {}) {
    this.#bom = bom;
  }

  /**
   * Reads one line, with no "\n".
   * @param {string} raw
   * @returns {Entry | undefined}
   */
  read(raw) {
    this.#number++;
    this.delimiter = -1;
    let text = raw;
    if (this.#bom && this.#number === 1 && text.startsWith(BOM)) {
      text = text.slice(1);
    }

    const line = trim(text);
    if (line === "") {
      return;
    }
    if (line[0] === "#" || line[0] === ";") {
      return {
        type: "comment",
        section: this.#section,
        line: this.#number,
        text: line,
      };
    }

    if (line[0] === "[" && line.at(-1) === "]") {
      this.#section = trim(line.slice(1, -1));
      this.#count = 1;
      return { type: "section", section: this.#section, line: this.#number };
    }

    if (this.#section === "") {
      throw this.#error("has a key in a section with no name");
    }

    let key, end;
    const quote = startsWithQuotes(line)
      ? '"""'
      : line[0] === '"' || line[0] === "`"
      ? line[0]
      : "";
    if (quote) {
      const close = line.indexOf(quote, quote.length);
      if (close === -1) {
        throw this.#error("has a key with no quote at the end");
      }
      key = line.slice(quote.length, close);
      end = delimiter(line, close);
    } else {
      end = delimiter(line, 0);
      key = trim(line.slice(0, Math.max(end, 0)));
    }
    if (end <= 0) {
      throw this.#error('has no "=" or ":" after a key');
    }

    /** @type {Entry} */
    const entry = {
      type: "key",
      section: this.#section,
      line: this.#number,
      key,
      value: "",
    };
    if (key === "-") {
      entry.key = `#${this.#count++}`;
      entry.auto = true;
    }

    let value = trim(line.slice(end + 1));
    const valueQuote = value[0] === "`" && value.length >= 2
      ? "`"
      : startsWithQuotes(value)
      ? '"""'
      : "";
    if (valueQuote) {
      const close = value.lastIndexOf(valueQuote);
      if (close < valueQuote.length) {
        throw this.#error("has a value with no quote at the end");
      }
      value = value.slice(valueQuote.length, close);
    }
    entry.value = value;

    // The line starts after the byte order mark and the white space.
    this.delimiter = raw.length - text.replace(TRIM_START, "").length + end;
    return entry;
  }

  /**
   * An error with the number of the line, but not the text of the line,
   * which can have a password or a token.
   * @param {string} problem
   */
  #error(problem) {
    return new SyntaxError(`INI: line ${this.#number} ${problem}.`);
  }
}

/**
 * Makes the configuration from the entries, in the order of the file, as
 * `ConfigFile.SetValue` of goconfig.
 */
class ConfigBuilder {
  /** @type {Map<string, Map<string, string>>} */
  #sections = new Map();

  /** @param {Entry | undefined} entry */
  add(entry) {
    if (!entry || entry.type === "comment") return;
    // goconfig ignores an empty key.
    if (entry.type === "key" && entry.key === "") return;

    const section = sectionOf(entry);
    if (!this.#sections.has(section)) {
      this.#sections.set(section, new Map());
    }
    // The key " " only makes the section.
    if (entry.type === "key" && entry.key !== " ") {
      this.#sections.get(section).set(entry.key, entry.value);
    }
  }

  /** @returns {Config} */
  get value() {
    // Object.fromEntries makes own properties, so a name such as "__proto__"
    // does not change the prototype.
    return Object.fromEntries(
      [...this.#sections].map(([name, keys]) => [
        name,
        Object.fromEntries(keys),
      ]),
    );
  }
}

/**
 * The section of an entry. The section `[]` is DEFAULT.
 * @param {Entry} entry
 */
function sectionOf(entry) {
  return entry.section || DEFAULT;
}

/**
 * The line with a new value, with no change to the key and the `=` or `:`.
 * @param {{ text: string, delimiter: number }} line
 * @param {string} value
 */
function withValue({ text, delimiter }, value) {
  const head = text.slice(0, delimiter + 1);
  const after = text.slice(delimiter + 1);
  const space = after === "" || TRIM_START.test(after) ? " " : "";
  return head + space + writeLineValue(head, value) + eolOf(text);
}

/**
 * Writes the line of a key and its value.
 * @param {string} key
 * @param {string} value
 */
function writeLine(key, value) {
  const head = `${writeKey(key)} =`;
  return `${head} ${writeLineValue(head, value)}`;
}

/**
 * Writes the value of a line. A line that starts with "[" and ends with "]"
 * is a section for goconfig, thus the value goes in quotes then.
 * @param {string} head The line before the value.
 * @param {string} value
 */
function writeLineValue(head, value) {
  const written = writeValue(value);
  if (trim(head).startsWith("[") && written.endsWith("]")) {
    return `\`${value}\``;
  }
  return written;
}

/** "\r" when the line ends with "\r". @param {string} text */
function eolOf(text) {
  return text.endsWith("\r") ? "\r" : "";
}

/**
 * Writes a section name, which goconfig reads with no white space at its two
 * ends.
 * @param {string} name
 */
function writeSection(name) {
  if (name === "" || name.includes("\n") || trim(name) !== name) {
    throw new TypeError(
      `INI: the section name ${JSON.stringify(name)} cannot be written.`,
    );
  }
  return name;
}

/**
 * Writes a key, in quotes when goconfig does not read it the same with no
 * quotes. The quotes are the quotes of goconfig for a key with "=" or ":".
 * goconfig reads a key in quotes to the first quote at the end.
 * @param {string} key
 */
function writeKey(key) {
  if (key === "" || key === " " || key === "-" || key.includes("\n")) {
    throw new TypeError(
      `INI: the key ${JSON.stringify(key)} cannot be written.`,
    );
  }
  // A key that starts with "[" needs care for its value: see
  // writeLineValue.
  if (trim(key) === key && !/^[#;"`]|[=:]/.test(key)) {
    return key;
  }
  if (!key.includes("`")) {
    return `\`${key}\``;
  }
  if (!key.includes('"')) {
    return `"${key}"`;
  }
  if (!key.includes('"""') && !key.endsWith('"')) {
    return `"""${key}"""`;
  }
  throw new TypeError(`INI: the key ${JSON.stringify(key)} cannot be written.`);
}

/**
 * Writes a value, in quotes when goconfig does not read it the same with no
 * quotes. goconfig reads a value in quotes to the last quote of the line,
 * thus each value with no line break can go in quotes.
 * @param {string} value
 */
function writeValue(value) {
  if (value.includes("\n")) {
    throw new TypeError("INI: a value cannot have a line break.");
  }
  // goconfig writes a value with "`" in """ quotes, but it writes the value
  // in " quotes when the value has no '"'. Then it cannot read the value
  // back, because a value in " quotes keeps its quotes.
  if (value.includes("`")) {
    return `"""${value}"""`;
  }
  if (trim(value) !== value || value.startsWith('"""')) {
    return `\`${value}\``;
  }
  return value;
}

/**
 * Removes the white space at the two ends, as `strings.TrimSpace` of Go.
 * @param {string} text
 */
function trim(text) {
  return text.replace(TRIM, "");
}

/**
 * Tells if a text starts with `"""` and has 6 bytes or more in UTF-8, as
 * goconfig checks it for `"""` quotes. Thus `"""é` is not in quotes, but
 * `"""€` is in quotes with no end, which is an error.
 * @param {string} text
 */
function startsWithQuotes(text) {
  return text.startsWith('"""') && encoder.encode(text).length >= 6;
}

/**
 * Gives the position of the first "=" or ":" from a position, or -1.
 * @param {string} line
 * @param {number} from
 */
function delimiter(line, from) {
  const found = line.slice(from).search(/[=:]/);
  return found === -1 ? -1 : from + found;
}
