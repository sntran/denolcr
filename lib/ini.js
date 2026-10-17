/**
 * The configuration file of rclone, in the INI format of the library goconfig
 * v1.0.0 (github.com/unknwon/goconfig), which rclone uses to read and write
 * the file:
 *
 * ```ini
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
 * - An empty line, and a line that starts with `#` or `;`, give nothing.
 * - `[name]` starts a section. The keys before the first section go in the
 *   section `DEFAULT`. Two sections with the same name become one.
 * - `key = value` and `key: value` set a key. The first `=` or `:` is the
 *   end of the key.
 * - A key in quotes (`` `key` ``, `"key"` or `"""key"""`) keeps its white
 *   space, and can have `=` and `:`.
 * - A value in quotes (`` `value` `` or `"""value"""`) keeps its white space.
 *   The value ends at the last quote of the line.
 * - The key `-` gets a number in its section: `#1`, then `#2`, and so on.
 */

/** The section of the keys before the first section. */
export const DEFAULT = "DEFAULT";

/** The white space that `strings.TrimSpace` of Go removes. */
const SPACE =
  "[\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]";
const TRIM = new RegExp(`^${SPACE}+|${SPACE}+$`, "g");

const encoder = new TextEncoder();

/**
 * An item of a configuration file: the start of a section, or a key and its
 * value in a section.
 * @typedef {{ section: string, key?: string, value?: string }} Entry
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
 * size, and gives an entry for each section and for each key, line by line.
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
 * Writes a configuration file that rclone reads as the same configuration.
 * The keys of the section `DEFAULT` come first with no `[DEFAULT]` line, when
 * `DEFAULT` is the first section. Then each section comes, with an empty line
 * between the sections, as rclone writes them. A key with no value
 * (undefined or null) is not written.
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
      .map(([key, value]) => `${writeKey(key)} = ${writeValue(`${value}`)}`);

    if (name === DEFAULT && index === 0 && lines.length) {
      blocks.push(lines);
    } else {
      blocks.push([`[${writeSection(name)}]`, ...lines]);
    }
  }
  return blocks.map((lines) => lines.join("\n")).join("\n\n");
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

  /**
   * Reads one line, with no "\n".
   * @param {string} text
   * @returns {Entry | undefined}
   */
  read(text) {
    this.#number++;
    // goconfig removes the byte order mark at the start of the file.
    if (this.#number === 1 && text.startsWith("﻿")) {
      text = text.slice(1);
    }

    const line = trim(text);
    if (line === "" || line[0] === "#" || line[0] === ";") {
      return;
    }

    if (line[0] === "[" && line.at(-1) === "]") {
      this.#section = trim(line.slice(1, -1));
      this.#count = 1;
      // The section `[]` is the section DEFAULT, but it cannot have keys.
      return { section: this.#section || DEFAULT };
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

    if (key === "-") {
      key = `#${this.#count++}`;
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

    // goconfig ignores an empty key. The key " " marks that a section
    // exists, thus it is not a key.
    if (key === "") return;
    if (key === " ") return { section: this.#section };
    return { section: this.#section, key, value };
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

/** Makes the configuration from the entries, in the order of the file. */
class ConfigBuilder {
  /** @type {Map<string, Map<string, string>>} */
  #sections = new Map();

  /** @param {Entry | undefined} entry */
  add(entry) {
    if (!entry) return;
    const { section, key, value } = entry;
    if (!this.#sections.has(section)) {
      this.#sections.set(section, new Map());
    }
    if (key !== undefined) {
      this.#sections.get(section).set(key, value);
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
  // A key at the start of the file must not start with U+FEFF, which is
  // the byte order mark there.
  if (trim(key) === key && !/^[#;"`[\uFEFF]|[=:]/.test(key)) {
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
