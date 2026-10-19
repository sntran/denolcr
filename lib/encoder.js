/**
 * The encoding of the names of rclone, as the package lib/encoder of rclone
 * 1.75.1.
 *
 * Some remotes cannot keep some characters in a name, for example `/` or
 * `\`. The encoder replaces such a character with a character that looks
 * almost the same. For most characters, this is the FULLWIDTH form, for
 * example `／` for `/`. When the name already has the replacement character,
 * the encoder puts the quote `‛` before it. Thus the decoder can find the
 * original name.
 *
 * A mask is a number. Each bit of the mask is a flag that encodes some
 * characters. The option `encoding` of a backend sets the mask, for example
 * `Slash,BackSlash,Del,Ctl`.
 */

/** The quote that the encoder puts before a character to keep it. */
export const QuoteRune = "‛";

/** No flag. All the masks encode NUL (0x00), but `EncodeRaw` does not. */
export const EncodeZero = 0;
/** No encoding. This flag works only alone: the names do not change. */
export const EncodeRaw = 1;
/** Encodes `/`. */
export const EncodeSlash = 1 << 1;
/** Encodes `<` and `>`. */
export const EncodeLtGt = 1 << 2;
/** Encodes `"`. */
export const EncodeDoubleQuote = 1 << 3;
/** Encodes `'`. */
export const EncodeSingleQuote = 1 << 4;
/** Encodes `` ` ``. */
export const EncodeBackQuote = 1 << 5;
/** Encodes `$`. */
export const EncodeDollar = 1 << 6;
/** Encodes `:`. */
export const EncodeColon = 1 << 7;
/** Encodes `?`. */
export const EncodeQuestion = 1 << 8;
/** Encodes `*`. */
export const EncodeAsterisk = 1 << 9;
/** Encodes `|`. */
export const EncodePipe = 1 << 10;
/** Encodes `#`. */
export const EncodeHash = 1 << 11;
/** Encodes `%`. */
export const EncodePercent = 1 << 12;
/** Encodes `\`. */
export const EncodeBackSlash = 1 << 13;
/** Encodes CR (0x0D) and LF (0x0A). */
export const EncodeCrLf = 1 << 14;
/** Encodes DEL (0x7F). */
export const EncodeDel = 1 << 15;
/** Encodes the control characters, from 0x01 to 0x1F. */
export const EncodeCtl = 1 << 16;
/** Encodes a space at the start of a name. */
export const EncodeLeftSpace = 1 << 17;
/** Encodes a `.` at the start of a name. */
export const EncodeLeftPeriod = 1 << 18;
/** Encodes a `~` at the start of a name. */
export const EncodeLeftTilde = 1 << 19;
/** Encodes a CR, LF, HT or VT at the start of a name. */
export const EncodeLeftCrLfHtVt = 1 << 20;
/** Encodes a space at the end of a name. */
export const EncodeRightSpace = 1 << 21;
/** Encodes a `.` at the end of a name. */
export const EncodeRightPeriod = 1 << 22;
/** Encodes a CR, LF, HT or VT at the end of a name. */
export const EncodeRightCrLfHtVt = 1 << 23;
/**
 * Encodes the bytes that are not correct UTF-8. In JavaScript, this flag
 * changes nothing: a string cannot keep such bytes. Thus the masks and
 * `parseEncoding` keep this flag, but the encoder and the decoder do not
 * use it. With this flag, rclone also decodes `‛` and two hexadecimal
 * digits to one byte, for example `‛41` to `A`. This module does not do
 * that.
 */
export const EncodeInvalidUtf8 = 1 << 24;
/** Encodes the names `.` and `..`. */
export const EncodeDot = 1 << 25;
/** Encodes `[` and `]`. */
export const EncodeSquareBracket = 1 << 26;
/** Encodes `;`. */
export const EncodeSemicolon = 1 << 27;
/** Encodes `!`. */
export const EncodeExclamation = 1 << 28;

/** Encodes `:?"*<>|`, the characters that Windows cannot keep in a name. */
export const EncodeWin = EncodeColon | EncodeQuestion | EncodeDoubleQuote |
  EncodeAsterisk | EncodeLtGt | EncodePipe;
/** Encodes `#` and `%`. */
export const EncodeHashPercent = EncodeHash | EncodePercent;

/**
 * The encoding of the paths that rclone reads and writes. It encodes NUL,
 * `/`, the control characters, DEL, and the names `.` and `..`.
 */
export const Standard = EncodeZero | EncodeSlash | EncodeCtl | EncodeDel |
  EncodeDot;

/** The encoding of NUL, `/`, and the names `.` and `..` only. */
export const Base = EncodeZero | EncodeSlash | EncodeDot;

/** The names of the flags for the option `encoding`, as rclone. */
const NAMES = new Map([
  ["Raw", EncodeRaw],
  ["None", EncodeZero],
  ["Slash", EncodeSlash],
  ["LtGt", EncodeLtGt],
  ["SquareBracket", EncodeSquareBracket],
  ["Semicolon", EncodeSemicolon],
  ["Exclamation", EncodeExclamation],
  ["DoubleQuote", EncodeDoubleQuote],
  ["SingleQuote", EncodeSingleQuote],
  ["BackQuote", EncodeBackQuote],
  ["Dollar", EncodeDollar],
  ["Colon", EncodeColon],
  ["Question", EncodeQuestion],
  ["Asterisk", EncodeAsterisk],
  ["Pipe", EncodePipe],
  ["Hash", EncodeHash],
  ["Percent", EncodePercent],
  ["BackSlash", EncodeBackSlash],
  ["CrLf", EncodeCrLf],
  ["Del", EncodeDel],
  ["Ctl", EncodeCtl],
  ["LeftSpace", EncodeLeftSpace],
  ["LeftPeriod", EncodeLeftPeriod],
  ["LeftTilde", EncodeLeftTilde],
  ["LeftCrLfHtVt", EncodeLeftCrLfHtVt],
  ["RightSpace", EncodeRightSpace],
  ["RightPeriod", EncodeRightPeriod],
  ["RightCrLfHtVt", EncodeRightCrLfHtVt],
  ["InvalidUtf8", EncodeInvalidUtf8],
  ["Dot", EncodeDot],
]);

/** The white space that `strings.TrimSpace` of Go removes. */
const SPACE = "[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a" +
  "\\u2028\\u2029\\u202f\\u205f\\u3000]";
const TRIM = new RegExp(`^${SPACE}+|${SPACE}+$`, "g");

/**
 * The syntax of `strconv.ParseUint` of Go with the base 0: a decimal number,
 * or a number with the prefix `0x`, `0o`, `0b` or `0`. One `_` can be
 * between two digits, or after the prefix.
 */
const UINT = new RegExp(
  "^(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+" +
    "|0(?:_?[0-7])*|[1-9](?:_?[0-9])*)$",
);

/**
 * Reads the value of the option `encoding` of rclone, as
 * `MultiEncoder.Set` of rclone. The value is a list of the names of the
 * flags, with `,` between them. A name can also be `None` for no flag, or a
 * number, for example `0x80`.
 * @param {string} text For example `Slash,BackSlash,Del,Ctl,RightPeriod`.
 * @returns {number} The mask. It keeps only the 32 low bits of a number:
 *   rclone has no flag in the other bits.
 * @throws {Error} For an unknown name, with the message of rclone.
 */
export function parseEncoding(text) {
  let mask = 0;
  for (let part of text.split(",")) {
    part = part.replace(TRIM, "");
    const flag = NAMES.get(part) ?? parseUint(part);
    if (flag === undefined) {
      const names = [...NAMES.keys()].sort().join(", ");
      // For most texts, the quotes of JSON are the same as `%q` of Go.
      throw new Error(
        `bad encoding ${JSON.stringify(part)}: possible values are: ${names}`,
      );
    }
    mask |= flag;
  }
  return mask >>> 0;
}

/**
 * Reads a number as `strconv.ParseUint` of Go, with the base 0 and 64 bits.
 * @param {string} text
 * @returns {number | undefined} The 32 low bits of the number, or no
 *   number for a text that Go does not accept.
 */
function parseUint(text) {
  if (!UINT.test(text)) return undefined;
  let digits = text.replaceAll("_", "");
  // BigInt does not read an octal number with only a `0` before it.
  if (/^0[0-7]/.test(digits)) digits = `0o${digits.slice(1)}`;
  const value = BigInt(digits);
  if (value >= 2n ** 64n) return undefined;
  return Number(BigInt.asUintN(32, value));
}

/**
 * Adds a number to the code of each character of a text.
 * @param {string} text
 * @param {number} offset
 * @returns {string}
 */
function shift(text, offset) {
  return String.fromCharCode(
    ...[...text].map((character) => character.charCodeAt(0) + offset),
  );
}

/** The number to add to an ASCII character to get its FULLWIDTH form. */
const FULL_OFFSET = 0xFEE0;
/** The number to add to a control character for its symbol, from `␀`. */
const SYMBOL_OFFSET = 0x2400;
/** The control characters, from 0x01 to 0x1F. */
const CONTROLS = String.fromCharCode(
  ...Array.from({ length: 0x1F }, (_, i) => i + 1),
);
/** HT, LF, VT and CR. */
const CR_LF_HT_VT = "\t\n\v\r";

/**
 * The characters that each flag encodes, and their replacements, in the
 * same order.
 * @type {[number, string, string][]}
 */
const REPLACEMENTS = [
  ...[
    [EncodeAsterisk, "*"],
    [EncodeLtGt, "<>"],
    [EncodeSquareBracket, "[]"],
    [EncodeSemicolon, ";"],
    [EncodeExclamation, "!"],
    [EncodeQuestion, "?"],
    [EncodeColon, ":"],
    [EncodePipe, "|"],
    [EncodeDoubleQuote, '"'],
    [EncodeSingleQuote, "'"],
    [EncodeBackQuote, "`"],
    [EncodeDollar, "$"],
    [EncodeSlash, "/"],
    [EncodeBackSlash, "\\"],
    [EncodeHash, "#"],
    [EncodePercent, "%"],
  ].map(([flag, text]) => [flag, text, shift(text, FULL_OFFSET)]),
  [EncodeCrLf, "\r\n", shift("\r\n", SYMBOL_OFFSET)],
  [EncodeDel, "\x7f", "␡"],
  [EncodeCtl, CONTROLS, shift(CONTROLS, SYMBOL_OFFSET)],
];

/**
 * For each character that a flag encodes: the flags, and the text that
 * the encoder puts in its place. A replacement is also in this map, with
 * the quote before it.
 * @type {Map<string, [number, string]>}
 */
const ENCODE = new Map();
/**
 * For each replacement: the flags that decode it, and the original
 * character.
 * @type {Map<string, [number, string]>}
 */
const DECODE = new Map();
for (const [flag, characters, replacements] of REPLACEMENTS) {
  for (let i = 0; i < characters.length; i++) {
    // CR and LF are in two flags, with the same replacements.
    const flags = (ENCODE.get(characters[i])?.[0] ?? 0) | flag;
    ENCODE.set(characters[i], [flags, replacements[i]]);
    ENCODE.set(replacements[i], [flags, QuoteRune + replacements[i]]);
    DECODE.set(replacements[i], [flags, characters[i]]);
  }
}

/**
 * The flags for the first character of a name, with the characters that
 * they encode and their replacements.
 * @type {[number, string, string][]}
 */
const LEFT = [
  [EncodeLeftSpace, " ", "␠"],
  [EncodeLeftPeriod, ".", "．"],
  [EncodeLeftTilde, "~", "～"],
  [EncodeLeftCrLfHtVt, CR_LF_HT_VT, shift(CR_LF_HT_VT, SYMBOL_OFFSET)],
];

/**
 * The flags for the last character of a name, with the characters that
 * they encode and their replacements.
 * @type {[number, string, string][]}
 */
const RIGHT = [
  [EncodeRightSpace, " ", "␠"],
  [EncodeRightPeriod, ".", "．"],
  [EncodeRightCrLfHtVt, CR_LF_HT_VT, shift(CR_LF_HT_VT, SYMBOL_OFFSET)],
];

/** The names that `EncodeDot` encodes, and their encoded names. */
const DOTS = new Map([
  [".", "．"],
  ["..", "．．"],
  ["．", `${QuoteRune}．`],
  ["．．", `${QuoteRune}．${QuoteRune}．`],
]);

/** The encoded names of `EncodeDot`, and their original names. */
const UNDOTS = new Map([...DOTS].map(([name, encoded]) => [encoded, name]));

/**
 * Encodes the first or the last character of a name.
 * @param {[number, string, string][]} edges `LEFT` or `RIGHT`.
 * @param {number} mask
 * @param {string} character
 * @returns {string} The text to put in the place of the character, or ""
 *   when the mask does not encode it.
 */
function encodeEdge(edges, mask, character) {
  for (const [flag, characters, replacements] of edges) {
    if ((mask & flag) === 0) continue;
    const index = characters.indexOf(character);
    if (index !== -1) return replacements[index];
    // A replacement keeps its form with the quote before it.
    if (replacements.includes(character)) return QuoteRune + character;
  }
  return "";
}

/**
 * Decodes the first or the last character of a name.
 * @param {[number, string, string][]} edges `LEFT` or `RIGHT`.
 * @param {number} mask
 * @param {string | undefined} character
 * @returns {string | undefined} The original character, or no character
 *   when the mask does not decode it.
 */
function decodeEdge(edges, mask, character) {
  if (character === undefined) return undefined;
  for (const [flag, characters, replacements] of edges) {
    if ((mask & flag) === 0) continue;
    const index = replacements.indexOf(character);
    if (index !== -1) return characters[index];
  }
  return undefined;
}

/**
 * Encodes a name, as `MultiEncoder.Encode` of rclone. The encoder replaces
 * the characters that the mask encodes, and puts the quote `‛` before the
 * characters that are already a replacement.
 * @param {string} name A name with no encoding, for example `a/b:c`.
 * @param {number} mask For example `EncodeSlash | EncodeColon`.
 * @returns {string} For example `a／b：c`.
 */
export function encodeName(name, mask) {
  if (mask === EncodeRaw || name === "") return name;
  if (mask & EncodeDot && DOTS.has(name)) return DOTS.get(name);

  const prefix = encodeEdge(LEFT, mask, name[0]);
  if (prefix) name = name.slice(1);
  const suffix = name && encodeEdge(RIGHT, mask, name.at(-1));
  if (suffix) name = name.slice(0, -1);

  let encoded = prefix;
  for (const character of name) {
    if (character === "\0") {
      encoded += "␀";
    } else if (character === "␀" || character === QuoteRune) {
      encoded += QuoteRune + character;
    } else {
      const entry = ENCODE.get(character);
      encoded += entry && mask & entry[0] ? entry[1] : character;
    }
  }
  return encoded + suffix;
}

/**
 * Decodes a name, as `MultiEncoder.Decode` of rclone: the reverse of
 * `encodeName`. A quote stays when no replacement is after it.
 * @param {string} name An encoded name, for example `a／b：c`.
 * @param {number} mask For example `EncodeSlash | EncodeColon`.
 * @returns {string} For example `a/b:c`.
 */
export function decodeName(name, mask) {
  if (mask === EncodeRaw) return name;
  if (mask & EncodeDot && UNDOTS.has(name)) return UNDOTS.get(name);

  let prefix = decodeEdge(LEFT, mask, name[0]) ?? "";
  if (prefix) {
    name = name.slice(1);
  } else if (
    name[0] === QuoteRune && decodeEdge(LEFT, mask, name[1]) !== undefined
  ) {
    prefix = name[1];
    name = name.slice(2);
  }

  let suffix = "";
  const last = decodeEdge(RIGHT, mask, name.at(-1));
  if (last !== undefined) {
    suffix = name.at(-1);
    name = name.slice(0, -1);
    // As rclone, a quote before the last character is the quote of that
    // character. Thus the name `a‛.` does not come back after the encoding.
    if (name.at(-1) === QuoteRune) {
      name = name.slice(0, -1);
    } else {
      suffix = last;
    }
  }

  let decoded = prefix;
  let quoted = false;
  for (const character of name) {
    const entry = DECODE.get(character);
    const replacement = character === "␀" ||
      entry !== undefined && (mask & entry[0]) !== 0;
    if (quoted) {
      quoted = false;
      if (replacement || character === QuoteRune) {
        decoded += character;
      } else {
        // The quote stays before a character that is not a replacement.
        decoded += QuoteRune + character;
      }
    } else if (character === QuoteRune) {
      quoted = true;
    } else if (character === "␀") {
      decoded += "\0";
    } else {
      decoded += replacement ? entry[1] : character;
    }
  }
  if (quoted) decoded += QuoteRune;
  return decoded + suffix;
}

/**
 * Converts a name in the `Standard` encoding of rclone to the encoding of a
 * mask, as `FromStandardName` of rclone.
 * @param {string} name A name in the `Standard` encoding, for example
 *   `a／b`.
 * @param {number} mask
 * @returns {string} The name in the encoding of the mask.
 */
export function fromStandardName(name, mask) {
  if (mask === Standard) return name;
  return encodeName(decodeName(name, Standard), mask);
}

/**
 * Converts a name in the encoding of a mask to the `Standard` encoding of
 * rclone, as `ToStandardName` of rclone.
 * @param {string} name A name in the encoding of the mask.
 * @param {number} mask
 * @returns {string} The name in the `Standard` encoding.
 */
export function toStandardName(name, mask) {
  if (mask === Standard) return name;
  return encodeName(decodeName(name, mask), Standard);
}

/**
 * Converts a path in the `Standard` encoding of rclone to the encoding of a
 * mask, as `FromStandardPath` of rclone. The function converts each name
 * between the `/` of the path.
 * @param {string} path A path in the `Standard` encoding, for example
 *   `dir/a：b`.
 * @param {number} mask
 * @returns {string} The path in the encoding of the mask.
 */
export function fromStandardPath(path, mask) {
  if (mask === Standard) return path;
  return path.split("/").map((name) => fromStandardName(name, mask)).join(
    "/",
  );
}

/**
 * Converts a path in the encoding of a mask to the `Standard` encoding of
 * rclone, as `ToStandardPath` of rclone. The function converts each name
 * between the `/` of the path.
 * @param {string} path A path in the encoding of the mask.
 * @param {number} mask
 * @returns {string} The path in the `Standard` encoding.
 */
export function toStandardPath(path, mask) {
  if (mask === Standard) return path;
  return path.split("/").map((name) => toStandardName(name, mask)).join("/");
}
