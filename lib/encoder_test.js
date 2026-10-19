import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  Base,
  decodeName,
  EncodeAsterisk,
  EncodeBackQuote,
  EncodeBackSlash,
  EncodeColon,
  EncodeCrLf,
  EncodeCtl,
  EncodeDel,
  EncodeDollar,
  EncodeDot,
  EncodeDoubleQuote,
  EncodeExclamation,
  EncodeHash,
  EncodeHashPercent,
  EncodeInvalidUtf8,
  EncodeLeftCrLfHtVt,
  EncodeLeftPeriod,
  EncodeLeftSpace,
  EncodeLeftTilde,
  EncodeLtGt,
  encodeName,
  EncodePercent,
  EncodePipe,
  EncodeQuestion,
  EncodeRaw,
  EncodeRightCrLfHtVt,
  EncodeRightPeriod,
  EncodeRightSpace,
  EncodeSemicolon,
  EncodeSingleQuote,
  EncodeSlash,
  EncodeSquareBracket,
  EncodeWin,
  EncodeZero,
  fromStandardName,
  fromStandardPath,
  parseEncoding,
  QuoteRune,
  Standard,
  toStandardName,
  toStandardPath,
} from "./encoder.js";

/** The mask of OneDrive in the benchmarks of rclone. */
const ONEDRIVE = Standard | EncodeWin | EncodeBackSlash | EncodeHashPercent |
  EncodeDel | EncodeCtl | EncodeLeftTilde | EncodeRightSpace |
  EncodeRightPeriod;

/** The default mask of the S3 backend of rclone. */
const S3 = EncodeInvalidUtf8 | EncodeSlash | EncodeDot;

/** The default mask of the OpenDrive backend of rclone. */
const OPENDRIVE = Base | EncodeWin | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt |
  EncodeBackSlash | EncodeLeftSpace | EncodeRightSpace | EncodeInvalidUtf8;

/** The default mask of the ShareFile backend of rclone. */
const SHAREFILE = Base | EncodeWin | EncodeBackSlash | EncodeCtl |
  EncodeRightSpace | EncodeRightPeriod | EncodeLeftSpace | EncodeLeftPeriod |
  EncodeInvalidUtf8;

/** The message of rclone for an unknown name, after the name. */
const POSSIBLE_VALUES = "possible values are: Asterisk, BackQuote, " +
  "BackSlash, Colon, CrLf, Ctl, Del, Dollar, Dot, DoubleQuote, Exclamation, " +
  "Hash, InvalidUtf8, LeftCrLfHtVt, LeftPeriod, LeftSpace, LeftTilde, LtGt, " +
  "None, Percent, Pipe, Question, Raw, RightCrLfHtVt, RightPeriod, " +
  "RightSpace, Semicolon, SingleQuote, Slash, SquareBracket";

// rclone also tests `MultiEncoder.String`. This module has no such function.

test("parseEncoding reads the names of the flags, as rclone", () => {
  for (
    const [text, mask] of [
      ["Raw", EncodeRaw],
      ["None", EncodeZero],
      ["DoubleQuote", EncodeDoubleQuote],
      ["Dot", EncodeDot],
      ["LtGt,DoubleQuote,Colon,Question,Asterisk,Pipe", EncodeWin],
      ["Hash,Percent", EncodeHashPercent],
      ["Slash,Dollar,Colon", EncodeSlash | EncodeDollar | EncodeColon],
      ["Slash,0x80000000", EncodeSlash + 2 ** 31],
      [
        "Slash,BackSlash,Del,Ctl,RightPeriod,InvalidUtf8",
        EncodeSlash | EncodeBackSlash | EncodeDel | EncodeCtl |
        EncodeRightPeriod | EncodeInvalidUtf8,
      ],
      ["Raw,Slash", EncodeRaw | EncodeSlash],
      [" Slash , Dot ", EncodeSlash | EncodeDot],
      ["\tSlash\n", EncodeSlash],
      ["Slash\u00a0,\u3000Dot", EncodeSlash | EncodeDot],
      [
        "Exclamation,Semicolon,SquareBracket",
        EncodeExclamation | EncodeSemicolon | EncodeSquareBracket,
      ],
    ]
  ) {
    assert.equal(parseEncoding(text), mask, JSON.stringify(text));
  }
});

test("parseEncoding reads numbers as Go", () => {
  for (
    const [text, mask] of [
      ["0", 0],
      ["010", 8],
      ["0x10", 16],
      ["0X10", 16],
      ["0b10", 2],
      ["0o17", 15],
      ["0x_1", 1],
      ["0_7", 7],
      ["1_000", 1000],
      // The mask keeps only the 32 low bits.
      ["4294967298", 2],
      ["18446744073709551615", 0xFFFFFFFF],
    ]
  ) {
    assert.equal(parseEncoding(text), mask, text);
  }
});

test("parseEncoding throws the error of rclone for an unknown name", () => {
  for (
    const [text, part] of [
      ["", ""],
      ["Blerp", "Blerp"],
      ["0xFGFFF", "0xFGFFF"],
      ["slash", "slash"],
      ["Slash,", ""],
      ["Slash, Blerp ,Dot", "Blerp"],
      ["08", "08"],
      ["0x", "0x"],
      ["1__0", "1__0"],
      ["_1", "_1"],
      ["1_", "1_"],
      ["+1", "+1"],
      ["-1", "-1"],
      ["1e3", "1e3"],
      ["18446744073709551616", "18446744073709551616"],
    ]
  ) {
    assert.throws(() => parseEncoding(text), {
      name: "Error",
      message: `bad encoding ${JSON.stringify(part)}: ${POSSIBLE_VALUES}`,
    }, JSON.stringify(text));
  }
  // As Go, the parser does not remove U+FEFF. Go writes it as `\ufeff` in
  // the message.
  assert.throws(() => parseEncoding("\ufeffSlash"), Error);
});

// rclone also tests names with bytes that are not correct UTF-8, in
// TestEncodeInvalidUnicode. A JavaScript string cannot keep such bytes. Thus
// this file skips these 10 cases.

test("encodeName and decodeName change the names . and .. with EncodeDot", () => {
  for (
    const [mask, name, encoded] of [
      [EncodeZero, ".", "."],
      [EncodeDot, ".", "．"],
      [EncodeZero, "..", ".."],
      [EncodeDot, "..", "．．"],
      [EncodeDot, "...", "..."],
      [EncodeDot, ". .", ". ."],
      [EncodeDot, "．", "‛．"],
      [EncodeDot, "．．", "‛．‛．"],
    ]
  ) {
    assert.equal(encodeName(name, mask), encoded, name);
    assert.equal(decodeName(encoded, mask), name, encoded);
  }
});

test("decodeName keeps a quote with no replacement after it", () => {
  for (
    const [mask, encoded, name] of [
      [EncodeZero, "‛", "‛"],
      [EncodeZero, "‛‛", "‛"],
      [EncodeZero, "‛a‛", "‛a‛"],
      [EncodeInvalidUtf8, "a‛B‛Eg", "a‛B‛Eg"],
      [EncodeInvalidUtf8, "a‛B＼‛Eg", "a‛B＼‛Eg"],
      [EncodeInvalidUtf8 | EncodeBackSlash, "a‛B＼‛Eg", "a‛B\\‛Eg"],
    ]
  ) {
    assert.equal(decodeName(encoded, mask), name, encoded);
  }
});

test("encodeName and decodeName pass the OneDrive cases of rclone", () => {
  for (
    const [name, encoded] of [
      ["", ""],
      ["abc 123", "abc 123"],
      [`\\*<>?:|#%".~`, `＼＊＜＞？：｜＃％＂.~`],
      [
        `\\*<>?:|#%".~/\\*<>?:|#%".~`,
        `＼＊＜＞？：｜＃％＂.~／＼＊＜＞？：｜＃％＂.~`,
      ],
      [" leading space", " leading space"],
      ["~leading tilde", "～leading tilde"],
      ["trailing dot.", "trailing dot．"],
      [
        " leading space/ leading space/ leading space",
        " leading space／ leading space／ leading space",
      ],
      [
        "~leading tilde/~leading tilde/~leading tilde",
        "～leading tilde／~leading tilde／~leading tilde",
      ],
      ["leading tilde/~leading tilde", "leading tilde／~leading tilde"],
      [
        "trailing dot./trailing dot./trailing dot.",
        "trailing dot.／trailing dot.／trailing dot．",
      ],
    ]
  ) {
    assert.equal(encodeName(name, ONEDRIVE), encoded, name);
    assert.equal(decodeName(encoded, ONEDRIVE), name, encoded);
  }
});

test("encodeName and decodeName do nothing with EncodeRaw", () => {
  for (const name of ["", "a/b", "\0", "‛", ".", "．", " a ", "a␀b"]) {
    assert.equal(encodeName(name, EncodeRaw), name, name);
    assert.equal(decodeName(name, EncodeRaw), name, name);
  }
});

test("fromStandardPath and toStandardPath convert each name of a path", () => {
  for (
    const [mask, standard, encoded] of [
      [Standard, "a/b．/c␀/d‛／", "a/b．/c␀/d‛／"],
      [ONEDRIVE, "~dir/file: name?.txt/end. ", "～dir/file： name？.txt/end.␠"],
      [S3, "a／b/．/．．/c␀d/x␊y", "a／b/．/．．/c␀d/x\ny"],
      [Base, "a␁b/‛／", "a\x01b/‛／"],
      [EncodeRaw, "a/b/．", "a/b/."],
      [ONEDRIVE, "", ""],
      [ONEDRIVE, "/", "/"],
    ]
  ) {
    assert.equal(fromStandardPath(standard, mask), encoded, standard);
    assert.equal(toStandardPath(encoded, mask), standard, encoded);
  }
  // A standard name with `／` becomes two names with no encoding of `/`.
  assert.equal(fromStandardPath("a／b/．．/c", EncodeZero), "a/b/../c");
  assert.equal(toStandardPath("a/../c", EncodeZero), "a/．．/c");
  // A replacement in a standard name gets a quote.
  assert.equal(
    fromStandardPath("～dir/file： name？.txt/end.␠", ONEDRIVE),
    "‛～dir/file‛： name‛？.txt/end.‛␠",
  );
});

test("fromStandardName and toStandardName also convert the `/`", () => {
  assert.equal(
    fromStandardName("~dir/file: name?.txt/end. ", ONEDRIVE),
    "～dir／file： name？.txt／end.␠",
  );
  assert.equal(
    toStandardName("～dir/file： name？.txt/end.␠", ONEDRIVE),
    "~dir／file: name?.txt／end. ",
  );
  assert.equal(fromStandardName("x␊y", Standard), "x␊y");
  assert.equal(fromStandardName("x␊y", S3), "x\ny");
  assert.equal(toStandardName("x\ny", S3), "x␊y");
});

/** The characters that a flag encodes, their replacements, and others. */
const CHARACTERS = [
  ..."\0\x01\x07\t\n\v\f\r\x1b\x1f\x7f /\\<>[];!?:|\"'`$#%*.~a",
  ..."␀␁␉␊␋␍␟␠␡／＼＜＞［］；！？：｜＂＇｀＄＃％＊．～",
  QuoteRune,
];

/** The flags for the last character of a name, and the characters. */
const RIGHT = [
  [EncodeRightSpace, " "],
  [EncodeRightPeriod, "."],
  [EncodeRightCrLfHtVt, "\t\n\v\r"],
];

/**
 * Tells if rclone gives back a name after the encoding and the decoding.
 * rclone does not in two cases:
 *
 * - The name ends with the quote and a character that a flag for the last
 *   character encodes. For example, `a‛.` with `EncodeRightPeriod`.
 * - The encoded name is an encoded name of `EncodeDot`, but the name is not
 *   `.` or `..`. For example, `．.` with `EncodeRightPeriod` gives `．．`.
 * @param {string} name
 * @param {number} mask
 * @returns {boolean}
 */
function rcloneGivesBack(name, mask) {
  if (
    name.at(-2) === QuoteRune &&
    RIGHT.some(([flag, characters]) =>
      mask & flag && characters.includes(name.at(-1))
    )
  ) {
    return false;
  }
  const dots = [".", "..", "．", "．．"];
  return !(mask & EncodeDot && !dots.includes(name) &&
    dots.map((dot) => encodeName(dot, mask)).includes(encodeName(name, mask)));
}

test("rclone does not give back some names, and this module does the same", () => {
  assert.equal(encodeName("a‛.", EncodeRightPeriod), "a‛‛．");
  assert.equal(decodeName("a‛‛．", EncodeRightPeriod), "a‛．");
  assert.equal(encodeName("．.", EncodeDot | EncodeRightPeriod), "．．");
  assert.equal(decodeName("．．", EncodeDot | EncodeRightPeriod), "..");
  assert.equal(rcloneGivesBack("a‛.", EncodeRightPeriod), false);
  assert.equal(rcloneGivesBack("．.", EncodeDot | EncodeRightPeriod), false);
});

test("decodeName gives back the name of encodeName, for some masks", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(
        EncodeZero,
        EncodeRaw,
        Base,
        Standard,
        ONEDRIVE,
        S3,
        OPENDRIVE,
        SHAREFILE,
      ),
      fc.oneof(
        fc.stringOf(
          fc.oneof(
            { arbitrary: fc.constantFrom(...CHARACTERS), weight: 4 },
            { arbitrary: fc.fullUnicode(), weight: 1 },
          ),
          { maxLength: 12 },
        ),
        fc.constantFrom(".", "..", "．", "．．"),
      ),
      (mask, name) => {
        fc.pre(rcloneGivesBack(name, mask));
        assert.equal(decodeName(encodeName(name, mask), mask), name);
      },
    ),
    { numRuns: 2000 },
  );
});

/**
 * Asserts that `encodeName` gives the encoded name of each case, and that
 * `decodeName` gives back the name.
 * @param {string} table
 * @param {[number, string, string][]} cases
 */
function assertCases(table, cases) {
  for (const [index, [mask, name, encoded]] of cases.entries()) {
    const message = `${table} ${index}: ${JSON.stringify(name)}`;
    assert.equal(encodeName(name, mask), encoded, message);
    assert.equal(decodeName(encoded, mask), name, message);
  }
}

// The cases of rclone 1.75.1, from lib/encoder/encoder_cases_test.go. A
// program of rclone makes them. Each case is a mask, a name, and its encoded
// name. That file has 10457 cases. This file keeps a part of them, in the
// order of that file:
//
// - SINGLE: all the cases of testCasesSingle.
// - SINGLE_EDGE: the first case of each mask of testCasesSingleEdge.
// - DOUBLE_EDGE: the first case of each mask of testCasesDoubleEdge.
// - EDGE_EXAMPLES: the cases at the end of testCasesSingleEdge that the
//   program writes by hand, but not the cases that SINGLE_EDGE has.
//
// No case of that file has bytes that are not correct UTF-8.

const SINGLE = [
  [
    EncodeZero,
    "＊2π%ｊ８｜aｗ␄k%\x15β\x00σ\\τ７␟'R\f␀τ；β7７␇",
    "＊2π%ｊ８｜aｗ␄k%\x15β␀σ\\τ７␟'R\f‛␀τ；β7７␇",
  ],
  [
    EncodeSlash,
    "␄␅VＪｇ：Ｋ|\x10+\x10／φ｀/π\n\bρRα\x03ζ？＜VLν␗ｑ",
    "␄␅VＪｇ：Ｋ|\x10+\x10‛／φ｀／π\n\bρRα\x03ζ？＜VLν␗ｑ",
  ],
  [
    EncodeSingleQuote,
    "γ␅＇Ｐｎ\fχ\nε␍[υ\r␉］ζM2ω␘＇$\nＡＮ␄^'\\\x7f",
    "γ␅‛＇Ｐｎ\fχ\nε␍[υ\r␉］ζM2ω␘‛＇$\nＡＮ␄^＇\\\x7f",
  ],
  [
    EncodeBackQuote,
    "\x17＼θWfｃＲ␟(［｀\vＶ６τη\x1d［'mυ>：#｜βw｛`ρ",
    "\x17＼θWfｃＲ␟(［‛｀\vＶ６τη\x1d［'mυ>：#｜βw｛｀ρ",
  ],
  [
    EncodeLtGt,
    "４＞>ｏ\n\x1bＰι,␅Pυ\x0e＜\n＂！９tπ＞<␎\b(ης：oε",
    "４‛＞＞ｏ\n\x1bＰι,␅Pυ\x0e‛＜\n＂！９tπ‛＞＜␎\b(ης：oε",
  ],
  [
    EncodeSquareBracket,
    "␛␡\fενm\x1bρ[M+τ\x19\\\x04νw＾］＃␚ｑ．ψＩ0Ｘ＃［]",
    "␛␡\fενm\x1bρ［M+τ\x19\\\x04νw＾‛］＃␚ｑ．ψＩ0Ｘ＃‛［］",
  ],
  [
    EncodeSemicolon,
    "Rφ#'\x06\x13ςY｜ψ＞ｌ%；ｙｓｏ$;;ς␆ξ␗␚\x1b[＼ι＼",
    "Rφ#'\x06\x13ςY｜ψ＞ｌ%‛；ｙｓｏ$；；ς␆ξ␗␚\x1b[＼ι＼",
  ],
  [
    EncodeExclamation,
    '\x17!;Ｘτ\x02？^εE！π\x01＆＃␇␐＆ψ＊ι～␀:~/"θ␎R',
    '\x17！;Ｘτ\x02？^εE‛！π\x01＆＃␇␐＆ψ＊ι～‛␀:~/"θ␎R',
  ],
  [
    EncodeDollar,
    "ωQ＝λ␕γ␗＄＂ε／#Ｒ$!$␚\x1e:Ｙ\x1e８\x7f$π␇ν\x19␁=",
    "ωQ＝λ␕γ␗‛＄＂ε／#Ｒ＄!＄␚\x1e:Ｙ\x1e８\x7f＄π␇ν\x19␁=",
  ],
  [
    EncodeDoubleQuote,
    'χ␙ρ\x13\x15Ｅ\t\x0fＣ␈\x15３sος␙７␔νk!π＂␆o␎"MＷ\x05',
    "χ␙ρ\x13\x15Ｅ\t\x0fＣ␈\x15３sος␙７␔νk!π‛＂␆o␎＂MＷ\x05",
  ],
  [
    EncodeColon,
    "\x1f\x18%～:／\x18Ｑ＋δω␆R｜：OζＩs␇\x7f／\x17?␊μτC；φ",
    "\x1f\x18%～：／\x18Ｑ＋δω␆R｜‛：OζＩs␇\x7f／\x17?␊μτC；φ",
  ],
  [
    EncodeQuestion,
    "Q␝Ｊａｌ？Vz\v␏␁\x16\x10?␛χκ?[␑ι\n＜␝ν\x15#βλＵ",
    "Q␝Ｊａｌ‛？Vz\v␏␁\x16\x10？␛χκ？[␑ι\n＜␝ν\x15#βλＵ",
  ],
  [
    EncodeAsterisk,
    'W=\x05ｘξβ＄\x1bmａε␡*␝!＊␡␊f\\"␑Yｈｚτ\x1fδτｋ',
    'W=\x05ｘξβ＄\x1bmａε␡＊␝!‛＊␡␊f\\"␑Yｈｚτ\x1fδτｋ',
  ],
  [
    EncodePipe,
    "#\x18␍␊Ｘ\x18␍ｋp＊λ\f:\x07θｔg]｜ｋρ;|υο␎Oξ␍｀",
    "#\x18␍␊Ｘ\x18␍ｋp＊λ\f:\x07θｔg]‛｜ｋρ;｜υο␎Oξ␍｀",
  ],
  [
    EncodeHash,
    "*［␄％μ$φ#$＄ｉδ%|␝ο＼χ\x1fxI）\x11yＧ＃！ςt９",
    "*［␄％μ$φ＃$＄ｉδ%|␝ο＼χ\x1fxI）\x11yＧ‛＃！ςt９",
  ],
  [
    EncodePercent,
    "DδＭ｀ξ␍\x06ρ␓ζ：＄Ｔ\x04␒φ!\x01Ｏ$%d%/γＷＪ\r％:",
    "DδＭ｀ξ␍\x06ρ␓ζ：＄Ｔ\x04␒φ!\x01Ｏ$％d％/γＷＪ\r‛％:",
  ],
  [
    EncodeBackSlash,
    "\x1aｌ^.\\ｘP␇ββσ\x10*\x01␓＼α＞\x16＊\":'／␄λ／ｅχＶ",
    "\x1aｌ^.＼ｘP␇ββσ\x10*\x01␓‛＼α＞\x16＊\":'／␄λ／ｅχＶ",
  ],
  [
    EncodeCrLf,
    "Fｇ！［␂π|\x0eY\nμ$＊0␊ν\x01VχI３␍＞\x00␐？δ\r␊ω",
    "Fｇ！［␂π|\x0eY␊μ$＊0‛␊ν\x01VχI３‛␍＞␀␐？δ␍‛␊ω",
  ],
  [
    EncodeDel,
    "ο␡：πς␓\x14ｏ␏*P:␙\x18d␊λδZ<;＆／\x7f\x00６［\x03Ｖδ",
    "ο‛␡：πς␓\x14ｏ␏*P:␙\x18d␊λδZ<;＆／␡␀６［\x03Ｖδ",
  ],
  [
    EncodeCtl,
    "␊\n␅␚ρ␉␄␈\x1f\\\x1bζ\x19␏ｔ␘\x07φ\f\x11\x05␃－␒␁␙␟␔ξ#␄ＸN␜\b\r\x14\x04␋\x10＜␑2!\x18\x1c\t␆\x06␞{␍␐␎5␝\x12ｃ\x1a\x03␗\x0e␛\b\x15\x1eX␛␐␌\x01\x1d\x17\x02\x1d8？\x13␖␂\x18\v␕＾␙\x0fα␕␇;μ␓\x16",
    "‛␊␊‛␅‛␚ρ‛␉‛␄‛␈␟\\␛ζ␙‛␏ｔ‛␘␇φ␌␑␅‛␃－‛␒‛␁‛␙‛␟‛␔ξ#‛␄ＸN‛␜␈␍␔␄‛␋␐＜‛␑2!␘␜␉‛␆␆‛␞{‛␍‛␐‛␎5‛␝␒ｃ␚␃‛␗␎‛␛␈␕␞X‛␛‛␐‛␌␁␝␗␂␝8？␓‛␖‛␂␘␋‛␕＾‛␙␏α‛␕‛␇;μ‛␓␖",
  ],
];

const SINGLE_EDGE = [
  [EncodeLeftSpace, " ", "␠"],
  [
    EncodeSlash | EncodeLeftSpace,
    '["α/／ｓ］␎ｄ\x19 ９~ζＯ\n␍ντU*Ｔ\x0eπｍ<eλ[␖',
    '["α／‛／ｓ］␎ｄ\x19 ９~ζＯ\n␍ντU*Ｔ\x0eπｍ<eλ[␖',
  ],
  [
    EncodeSingleQuote | EncodeLeftSpace,
    "\x16␎３ςδ＋３ζ␃ξ \x19␁［t］ｐα'␐6Ｋ]\x17odι%\x1cw",
    "\x16␎３ςδ＋３ζ␃ξ \x19␁［t］ｐα＇␐6Ｋ]\x17odι%\x1cw",
  ],
  [
    EncodeBackQuote | EncodeLeftSpace,
    '１＞＜"ξ］\r"&B ｑ␗␆σ；\t<␛b␑οF\x0eη）８\x04υ\x0f',
    '１＞＜"ξ］\r"&B ｑ␗␆σ；\t<␛b␑οF\x0eη）８\x04υ\x0f',
  ],
  [
    EncodeLtGt | EncodeLeftSpace,
    "＜～Ｘ｛＃＞\x10\x19)\x1b ␏_␇κβＦχ␔]［νB（\x1aπi'\x1fδ",
    "‛＜～Ｘ｛＃‛＞\x10\x19)\x1b ␏_␇κβＦχ␔]［νB（\x1aπi'\x1fδ",
  ],
  [
    EncodeSquareBracket | EncodeLeftSpace,
    "`γ\v\x12Ｉ\vζ)＊！ αζ\x1f=τ\x04F％Ｃς;<␈Ｈ␟␀␘ＢX",
    "`γ\v\x12Ｉ\vζ)＊！ αζ\x1f=τ\x04F％Ｃς;<␈Ｈ␟‛␀␘ＢX",
  ],
  [
    EncodeSemicolon | EncodeLeftSpace,
    "/%j2ｒＢ｀␍'ｖ Dυ␁:οπφＬ\x10;＃:␀\rＨ2［～φ",
    "/%j2ｒＢ｀␍'ｖ Dυ␁:οπφＬ\x10；＃:‛␀\rＨ2［～φ",
  ],
  [
    EncodeExclamation | EncodeLeftSpace,
    "］␟，χ％ι＄?]D 1εw\x14\x15Ｘη$␉>␟|ｕε；］\x16␌χ",
    "］␟，χ％ι＄?]D 1εw\x14\x15Ｘη$␉>␟|ｕε；］\x16␌χ",
  ],
  [
    EncodeDollar | EncodeLeftSpace,
    '３~?ε␞\x14μO？ψ {ς＼８１\np<"f␒\x1b␔Ｃ\x15␃｜ρＦ',
    '３~?ε␞\x14μO？ψ {ς＼８１\np<"f␒\x1b␔Ｃ\x15␃｜ρＦ',
  ],
  [
    EncodeDoubleQuote | EncodeLeftSpace,
    "Ｊ␛:o\x02%␍Oε␈ τａ\uff00χＫ\x0f␛\x12｜>９ς]ξ␃Ｊ\x07*`",
    "Ｊ␛:o\x02%␍Oε␈ τａ\uff00χＫ\x0f␛\x12｜>９ς]ξ␃Ｊ\x07*`",
  ],
  [
    EncodeColon | EncodeLeftSpace,
    "␖\x1fλ］␙νο\tμ1 2\x03\x1fｙ\x03ＸＰδ␅V%ν\x7fＷｑ＊ S␒",
    "␖\x1fλ］␙νο\tμ1 2\x03\x1fｙ\x03ＸＰδ␅V%ν\x7fＷｑ＊ S␒",
  ],
  [
    EncodeQuestion | EncodeLeftSpace,
    "＊νμ␜V\x18\x07ｊθψ θSψU８2j\x01?␂`Ｐ\x17%！␕ｔｖ＃",
    "＊νμ␜V\x18\x07ｊθψ θSψU８2j\x01？␂`Ｐ\x17%！␕ｔｖ＃",
  ],
  [
    EncodeAsterisk | EncodeLeftSpace,
    "５＂＾␅\x16␡ςＪM' ＇％AB␡；\x7fχπ７Dχ5!θ\r\x00'Ｚ",
    "５＂＾␅\x16␡ςＪM' ＇％AB␡；\x7fχπ７Dχ5!θ\r␀'Ｚ",
  ],
  [
    EncodePipe | EncodeLeftSpace,
    "Y！\x06␟ｏ！\x12＝！I λ＇α＆g\x16\x1bJν*｜Rφ｀ψ/␞␌σ",
    "Y！\x06␟ｏ！\x12＝！I λ＇α＆g\x16\x1bJν*‛｜Rφ｀ψ/␞␌σ",
  ],
  [
    EncodeHash | EncodeLeftSpace,
    "\v␊φ\x11\x0e｝ζ0Ｎ7 \x10(＋ηυ／C\x1b?γS＂｝␆＂␈\r＼ρ",
    "\v␊φ\x11\x0e｝ζ0Ｎ7 \x10(＋ηυ／C\x1b?γS＂｝␆＂␈\r＼ρ",
  ],
  [
    EncodePercent | EncodeLeftSpace,
    "φg␕＋{<␚sＪ5 γν␔θ␟\x00．φ\x12[αuｎｄC␞␅]>",
    "φg␕＋{<␚sＪ5 γν␔θ␟␀．φ\x12[αuｎｄC␞␅]>",
  ],
  [
    EncodeBackSlash | EncodeLeftSpace,
    "．\x13␡ＭＵψ１J␆W ＂ςο\x18ｘ＊'<χｃυ?\x0e！50N；ς",
    "．\x13␡ＭＵψ１J␆W ＂ςο\x18ｘ＊'<χｃυ?\x0e！50N；ς",
  ],
  [
    EncodeCrLf | EncodeLeftSpace,
    "ε]Ｎ)␍Ｅτ␙=／ \\\x19＄\x15｜␙ωＥξ1s%３\n#␖\rκｇ",
    "ε]Ｎ)‛␍Ｅτ␙=／ \\\x19＄\x15｜␙ωＥξ1s%３␊#␖␍κｇ",
  ],
  [
    EncodeDel | EncodeLeftSpace,
    "\x14\bθ／^βδ␀a； H#＞\x00\x12␐／Ｍγ\x05␛ς＄Ｕ&Ｎ␐eη",
    "\x14\bθ／^βδ‛␀a； H#＞␀\x12␐／Ｍγ\x05␛ς＄Ｕ&Ｎ␐eη",
  ],
  [
    EncodeCtl | EncodeLeftSpace,
    "␉B␑ｓ5}φｕｂ␉ \x0f\rξ@\x17βhι/＞\x18＼␈＜Ｍυ{ｉ]",
    "‛␉B‛␑ｓ5}φｕｂ‛␉ ␏␍ξ@␗βhι/＞␘＼‛␈＜Ｍυ{ｉ]",
  ],
  [EncodeLeftPeriod, ".", "．"],
  [
    EncodeSlash | EncodeLeftPeriod,
    "ε－π␍ιＮX,Eα.＼*｜ι\x14Ｇ␒␚;*θV％Ｋ+]␡ＢG",
    "ε－π␍ιＮX,Eα.＼*｜ι\x14Ｇ␒␚;*θV％Ｋ+]␡ＢG",
  ],
  [
    EncodeSingleQuote | EncodeLeftPeriod,
    "\x0e:ｚπ９７␖ξ＼U.e#l\rξ%\nι\x1b／／１κｆ＃␔ςs＄",
    "\x0e:ｚπ９７␖ξ＼U.e#l\rξ%\nι\x1b／／１κｆ＃␔ςs＄",
  ],
  [
    EncodeBackQuote | EncodeLeftPeriod,
    "／？#␅ ;␞␖\rO.lητ`ｄｌ\x01]］ιψ＊\x12γ(ρ0～：",
    "／？#␅ ;␞␖\rO.lητ｀ｄｌ\x01]］ιψ＊\x12γ(ρ0～：",
  ],
  [
    EncodeLtGt | EncodeLeftPeriod,
    "Ｕ(!υ＇＃\x04sLρ.>'{ｘ\x05］␜␌Ｌτ＞\x07υυ！｛＃σ'",
    "Ｕ(!υ＇＃\x04sLρ.＞'{ｘ\x05］␜␌Ｌτ‛＞\x07υυ！｛＃σ'",
  ],
  [
    EncodeSquareBracket | EncodeLeftPeriod,
    "V！\x0f＄␃\x1fλβｆ1.I；;/o？Wψｍ\rςζｂ!２␕␊!｛",
    "V！\x0f＄␃\x1fλβｆ1.I；;/o？Wψｍ\rςζｂ!２␕␊!｛",
  ],
  [
    EncodeSemicolon | EncodeLeftPeriod,
    "\x1f␔`４`ωＶζυ$.ν␛TｅAqw\x11␈θ\x17@ψｗ␙␗Ｓ１\x02",
    "\x1f␔`４`ωＶζυ$.ν␛TｅAqw\x11␈θ\x17@ψｗ␙␗Ｓ１\x02",
  ],
  [
    EncodeExclamation | EncodeLeftPeriod,
    "␍)\x1c＋␃ｌυ＄␙\r.δ／＇.*:\b␏δ？Ｗ␔$1τ?`οφ",
    "␍)\x1c＋␃ｌυ＄␙\r.δ／＇.*:\b␏δ？Ｗ␔$1τ?`οφ",
  ],
  [
    EncodeDollar | EncodeLeftPeriod,
    "\x06)μk{␊＊９␊Ａ.\x04π\x1e\x0e␖ｍ＜\x1aｓ\x04Hσ-＂@χ＄λ％",
    "\x06)μk{␊＊９␊Ａ.\x04π\x1e\x0e␖ｍ＜\x1aｓ\x04Hσ-＂@χ‛＄λ％",
  ],
  [
    EncodeDoubleQuote | EncodeLeftPeriod,
    "\x1d\x07sG#ο\v␋＄7.␡λ＂｀␌ν［５ω]＂\x00＂[～οsη１",
    "\x1d\x07sG#ο\v␋＄7.␡λ‛＂｀␌ν［５ω]‛＂␀‛＂[～οsη１",
  ],
  [
    EncodeColon | EncodeLeftPeriod,
    "ςε］ｃV|␟5S␎.\rＣＬo␍\\π{\n\x1aι：\x01␟π｝！\x07␌",
    "ςε］ｃV|␟5S␎.\rＣＬo␍\\π{\n\x1aι‛：\x01␟π｝！\x07␌",
  ],
  [
    EncodeQuestion | EncodeLeftPeriod,
    "␒:W%＆ξ（\x16␊ｒ.π\x06''Vξη^␆h＇D[τＰθ␔２␛",
    "␒:W%＆ξ（\x16␊ｒ.π\x06''Vξη^␆h＇D[τＰθ␔２␛",
  ],
  [
    EncodeAsterisk | EncodeLeftPeriod,
    "+υXＡξ\x04\\［␑\x05.␟＆Ｗζυ;／c\x02:ｎ␈８␖x!XρＷ",
    "+υXＡξ\x04\\［␑\x05.␟＆Ｗζυ;／c\x02:ｎ␈８␖x!XρＷ",
  ],
  [
    EncodePipe | EncodeLeftPeriod,
    "κ＂␄␖␁a␕：V［.ι！μχ/!ς＊\x06ω\"\x00％Ｊ\td'\uff00!",
    "κ＂␄␖␁a␕：V［.ι！μχ/!ς＊\x06ω\"␀％Ｊ\td'\uff00!",
  ],
  [
    EncodeHash | EncodeLeftPeriod,
    '!3"j]Aｓσ␛␂.πＰｂξ@＜␐\x12θι＂Ｓ＊ο\x14H!\x1e␑',
    '!3"j]Aｓσ␛␂.πＰｂξ@＜␐\x12θι＂Ｓ＊ο\x14H!\x1e␑',
  ],
  [
    EncodePercent | EncodeLeftPeriod,
    "τＡτkＢ|␀γ$␎.＿\x7fμψ␀U\nτｂ\n4␖2?d␇␅］ｚ",
    "τＡτkＢ|‛␀γ$␎.＿\x7fμψ‛␀U\nτｂ\n4␖2?d␇␅］ｚ",
  ],
  [
    EncodeBackSlash | EncodeLeftPeriod,
    "\\（\x02５␃I␜ｑ%N.\nZｐφ＜␃ζ\rχξτt'ｐ␊Ｃφ:|",
    "＼（\x02５␃I␜ｑ%N.\nZｐφ＜␃ζ\rχξτt'ｐ␊Ｃφ:|",
  ],
  [
    EncodeCrLf | EncodeLeftPeriod,
    "␎:'６\x03＆ξω\tｆ.θ␗6ρ\x1a␔＋\\ｕ％tIφ␏ｄKω+\x0e",
    "␎:'６\x03＆ξω\tｆ.θ␗6ρ\x1a␔＋\\ｕ％tIφ␏ｄKω+\x0e",
  ],
  [
    EncodeDel | EncodeLeftPeriod,
    "␓ＨＷ\tG\x1b＄\x1a＿B.␓ζφψω＜%\x01＄i＿＞'λ?ｇ＿UG",
    "␓ＨＷ\tG\x1b＄\x1a＿B.␓ζφψω＜%\x01＄i＿＞'λ?ｇ＿UG",
  ],
  [
    EncodeCtl | EncodeLeftPeriod,
    'U␔\x7f＊φｗζ\x12\x12␝.Ｂ\x18Uυ␀｜0ψ＄\x06＄"s］＜βο\x15D',
    'U‛␔\x7f＊φｗζ␒␒‛␝.Ｂ␘Uυ‛␀｜0ψ＄␆＄"s］＜βο␕D',
  ],
  [EncodeLeftTilde, "~", "～"],
  [
    EncodeSlash | EncodeLeftTilde,
    "%ｓ␀\x0eψv＆ω＋#~␍ι＊Pe␊␚\x19\x1e＃Uρ＼υνＥ\x0e？?",
    "%ｓ‛␀\x0eψv＆ω＋#~␍ι＊Pe␊␚\x19\x1e＃Uρ＼υνＥ\x0e？?",
  ],
  [
    EncodeSingleQuote | EncodeLeftTilde,
    '５␓%φφ％L＊"\x1e~θv<τ１\\ηβ␋\x03ｄ␉x７␁\f；Ｋ\r',
    '５␓%φφ％L＊"\x1e~θv<τ１\\ηβ␋\x03ｄ␉x７␁\f；Ｋ\r',
  ],
  [
    EncodeBackQuote | EncodeLeftTilde,
    'ν"␈6Ｕ<ｕξｈ｜~ｇｍπ\b␊οσ２3z␄｀\x13\t-␍\x16ε)',
    'ν"␈6Ｕ<ｕξｈ｜~ｇｍπ\b␊οσ２3z␄‛｀\x13\t-␍\x16ε)',
  ],
  [
    EncodeLtGt | EncodeLeftTilde,
    "Yε\x10m\x1f＇vｓCφ~｜ｗｇδ\r7ξ:\n\\＊␉Ｌμｋｆ␊？u",
    "Yε\x10m\x1f＇vｓCφ~｜ｗｇδ\r7ξ:\n\\＊␉Ｌμｋｆ␊？u",
  ],
  [
    EncodeSquareBracket | EncodeLeftTilde,
    ">\x1cκ␐␜Eω\x03dλ~＜␎z\x1cＸ[V/Ｎ␇ψ｜%\rμ＞μ＾␉",
    ">\x1cκ␐␜Eω\x03dλ~＜␎z\x1cＸ［V/Ｎ␇ψ｜%\rμ＞μ＾␉",
  ],
  [
    EncodeSemicolon | EncodeLeftTilde,
    "␝␊ｍ<；\uff001δj␏~Ｊ$γzRρ：%６\x04:\x07␡ιψ␏5χ)",
    "␝␊ｍ<‛；\uff001δj␏~Ｊ$γzRρ：%６\x04:\x07␡ιψ␏5χ)",
  ],
  [
    EncodeExclamation | EncodeLeftTilde,
    "'＄ζ>υ＃W\r]σ~f␉+/）\x10␄η<［ｒ；ς＼\x18８β␗a",
    "'＄ζ>υ＃W\r]σ~f␉+/）\x10␄η<［ｒ；ς＼\x18８β␗a",
  ],
  [
    EncodeDollar | EncodeLeftTilde,
    "σ＜χ*ω␒ｘ）{␂~\x03αUｈ|σｇ39␆y\x181\x01β␖\x0eｃ␇",
    "σ＜χ*ω␒ｘ）{␂~\x03αUｈ|σｇ39␆y\x181\x01β␖\x0eｃ␇",
  ],
  [
    EncodeDoubleQuote | EncodeLeftTilde,
    "|␒ｒＬφνu[:\x1c~ρｉPιd#␎｀ｐｂ␅σ\x19Mβ\x15␟／+",
    "|␒ｒＬφνu[:\x1c~ρｉPιd#␎｀ｐｂ␅σ\x19Mβ\x15␟／+",
  ],
  [
    EncodeColon | EncodeLeftTilde,
    "␜；:υφ\x11χζ{ｃ~␔-６＂\x04\bＳ]＠0％\x00υ\x0f；Dc␉κ",
    "␜；：υφ\x11χζ{ｃ~␔-６＂\x04\bＳ]＠0％␀υ\x0f；Dc␉κ",
  ],
  [
    EncodeQuestion | EncodeLeftTilde,
    "␖F'／Ｐ/Kπ/ｎ~ｃδ␜`ε$＞，-\x07λ\x05CW＾␄ςε␚",
    "␖F'／Ｐ/Kπ/ｎ~ｃδ␜`ε$＞，-\x07λ\x05CW＾␄ςε␚",
  ],
  [
    EncodeAsterisk | EncodeLeftTilde,
    '！␙W␈7φ`ｌεζ~␀（zａ`\x1bo|ｅＵν␄\r;rσ"／ｍ',
    '！␙W␈7φ`ｌεζ~‛␀（zａ`\x1bo|ｅＵν␄\r;rσ"／ｍ',
  ],
  [
    EncodePipe | EncodeLeftTilde,
    "\x16Ｌρ\x1eρＴ␐%\x00␓~QL␆\vM␘;\x16αθＹι．γ，a＊\x02␛",
    "\x16Ｌρ\x1eρＴ␐%␀␓~QL␆\vM␘;\x16αθＹι．γ，a＊\x02␛",
  ],
  [
    EncodeHash | EncodeLeftTilde,
    "]％␛e*b＜U#␌~\x1b\x17δ；Ｉ␕␁_\x12\t＃σςＢξω２ρ\x00",
    "]％␛e*b＜U＃␌~\x1b\x17δ；Ｉ␕␁_\x12\t‛＃σςＢξω２ρ␀",
  ],
  [
    EncodePercent | EncodeLeftTilde,
    'Zν\x05␂"␂O!ρｊ~ε\x18ωνｒ\x1bn＿ψＥ3ｗ␞F␍ｓ:y␓',
    'Zν\x05␂"␂O!ρｊ~ε\x18ωνｒ\x1bn＿ψＥ3ｗ␞F␍ｓ:y␓',
  ],
  [
    EncodeBackSlash | EncodeLeftTilde,
    "η＋(?γz|ｔａv~λ␗\x19\x05␘␒\x11＄ω８＂'!ε*）ψ␄＊",
    "η＋(?γz|ｔａv~λ␗\x19\x05␘␒\x11＄ω８＂'!ε*）ψ␄＊",
  ],
  [
    EncodeCrLf | EncodeLeftTilde,
    "＃υt␑［␝\x0fｏ␇λ~Ｗφ，%]＞!␓␀\x00\x1fHιψ\x06φ&u8",
    "＃υt␑［␝\x0fｏ␇λ~Ｗφ，%]＞!␓‛␀␀\x1fHιψ\x06φ&u8",
  ],
  [
    EncodeDel | EncodeLeftTilde,
    "|νＪ＝?␑＞γ／σ~#σｗl\x1bfπl$ｎ２T␍␟＜B\x1f\n␍",
    "|νＪ＝?␑＞γ／σ~#σｗl\x1bfπl$ｎ２T␍␟＜B\x1f\n␍",
  ],
  [
    EncodeCtl | EncodeLeftTilde,
    "\x14Ｓ＊１Ｑ␍[_ζ|~τ\rδＵ␗␆jξ\x1cνYＨＶ>%␂ζ<＼",
    "␔Ｓ＊１Ｑ‛␍[_ζ|~τ␍δＵ‛␗‛␆jξ␜νYＨＶ>%‛␂ζ<＼",
  ],
  [EncodeLeftCrLfHtVt, "\t", "␉"],
  [
    EncodeSlash | EncodeLeftCrLfHtVt,
    'χQ␙"ξ\n＝SＰ%\tκβ\x07φzW\x1d␆ｉ"␍␛5）τ６｀＊\x15',
    'χQ␙"ξ\n＝SＰ%\tκβ\x07φzW\x1d␆ｉ"␍␛5）τ６｀＊\x15',
  ],
  [
    EncodeSingleQuote | EncodeLeftCrLfHtVt,
    "β␙&Ｊ＿］;ｉτθ\t\x0eN␗Ｉ\x16aβ␈\x16＞>＄\x0e\x07_αＵｐη",
    "β␙&Ｊ＿］;ｉτθ\t\x0eN␗Ｉ\x16aβ␈\x16＞>＄\x0e\x07_αＵｐη",
  ],
  [
    EncodeBackQuote | EncodeLeftCrLfHtVt,
    "GD［\v＃Ｔ＃σ>％\tmθ␝I～？\x00ｚｎλ\x06\x0f␉␞<υτdφ",
    "GD［\v＃Ｔ＃σ>％\tmθ␝I～？␀ｚｎλ\x06\x0f␉␞<υτdφ",
  ],
  [
    EncodeLtGt | EncodeLeftCrLfHtVt,
    "?`δＣπ\x00；γ␗３\t␜％］/ｑιｌN␃\x06#ρ4Ｐ9␖;xπ",
    "?`δＣπ␀；γ␗３\t␜％］/ｑιｌN␃\x06#ρ4Ｐ9␖;xπ",
  ],
  [
    EncodeSquareBracket | EncodeLeftCrLfHtVt,
    "δｆＢ/？ηyξ\x1aυ\t+␍＜␉＿\x14␗5%！θ␋eG>Ｘ\bκ\n",
    "δｆＢ/？ηyξ\x1aυ\t+␍＜␉＿\x14␗5%！θ␋eG>Ｘ\bκ\n",
  ],
  [
    EncodeSemicolon | EncodeLeftCrLfHtVt,
    "[＊9？Fφ␃ｆＶη\t␈＞\t\x16δｋ*#ψ３\x11O␁\x05｀τMρ␀",
    "[＊9？Fφ␃ｆＶη\t␈＞\t\x16δｋ*#ψ３\x11O␁\x05｀τMρ‛␀",
  ],
  [
    EncodeExclamation | EncodeLeftCrLfHtVt,
    '␎C6*Tａ！πζκ\tｏ]ζ＄ε^Ｙ／Ｔ"\x1fS＼τ\nＡＵ\x02\x0f',
    '␎C6*Tａ‛！πζκ\tｏ]ζ＄ε^Ｙ／Ｔ"\x1fS＼τ\nＡＵ\x02\x0f',
  ],
  [
    EncodeDollar | EncodeLeftCrLfHtVt,
    "␊ρW\tＦ－/τ！５\t␑\x12)ψ＜ｎ\x7f&nＡ>!␁ωπ？δ/4",
    "‛␊ρW\tＦ－/τ！５\t␑\x12)ψ＜ｎ\x7f&nＡ>!␁ωπ？δ/4",
  ],
  [
    EncodeDoubleQuote | EncodeLeftCrLfHtVt,
    "σ＃\n#４GV%ζχ\tP\b␍␌@ω␚［\n␟␊＆[２<D\uff00ωλ",
    "σ＃\n#４GV%ζχ\tP\b␍␌@ω␚［\n␟␊＆[２<D\uff00ωλ",
  ],
  [
    EncodeColon | EncodeLeftCrLfHtVt,
    "；Ｙ\x10␍＇NＭ?␡4\tχ％β\vG\x02\x15ξ␍？ωAQ\x12ｉＩnγι",
    "；Ｙ\x10␍＇NＭ?␡4\tχ％β\vG\x02\x15ξ␍？ωAQ\x12ｉＩnγι",
  ],
  [
    EncodeQuestion | EncodeLeftCrLfHtVt,
    "ε\t␚［\x1fιq！8ｚ\tｓ\nｅjb`\x12η␊␅\x05％χ\x12ＯοＯD－",
    "ε\t␚［\x1fιq！8ｚ\tｓ\nｅjb`\x12η␊␅\x05％χ\x12ＯοＯD－",
  ],
  [
    EncodeAsterisk | EncodeLeftCrLfHtVt,
    "8\x03ｅDς␘φ\x05－\x14\t＼Ｖ\x1d␋＾␓␀φω\x17␡␑4ηJνN\x02p",
    "8\x03ｅDς␘φ\x05－\x14\t＼Ｖ\x1d␋＾␓‛␀φω\x17␡␑4ηJνN\x02p",
  ],
  [
    EncodePipe | EncodeLeftCrLfHtVt,
    '␓␟Ｗ␊δω8$\x1dＤ\tH␈\x1f"μ＇Q␞/ｆω#β\x12[\x03θｇ＿',
    '␓␟Ｗ␊δω8$\x1dＤ\tH␈\x1f"μ＇Q␞/ｆω#β\x12[\x03θｇ＿',
  ],
  [
    EncodeHash | EncodeLeftCrLfHtVt,
    "\b\tφU␖］｜{Ｘγ\tθημ（ＵlT\x0fπ`␖ｑｚ｀；]␏\rZ",
    "\b\tφU␖］｜{Ｘγ\tθημ（ＵlT\x0fπ`␖ｑｚ｀；]␏\rZ",
  ],
  [
    EncodePercent | EncodeLeftCrLfHtVt,
    '␊;ａ>κ␜␘\x05@δ\tυＥ＃\x07j＊｜γξＧ\x00ｖB"␡θ＾%p',
    '‛␊;ａ>κ␜␘\x05@δ\tυＥ＃\x07j＊｜γξＧ␀ｖB"␡θ＾％p',
  ],
  [
    EncodeBackSlash | EncodeLeftCrLfHtVt,
    "␉\x12νλ#α６*S5\t／␁:ｕｌ\bφ␗␘␎?＆ω＾\x10Q\x1eφd",
    "‛␉\x12νλ#α６*S5\t／␁:ｕｌ\bφ␗␘␎?＆ω＾\x10Q\x1eφd",
  ],
  [
    EncodeDel | EncodeLeftCrLfHtVt,
    "Vｊ\x05Ｂ[＾＆␗α\x1b\tζｃ!␒λ␍\x16ιｑ$␞#i%ω@␂ρ␊",
    "Vｊ\x05Ｂ[＾＆␗α\x1b\tζｃ!␒λ␍\x16ιｑ$␞#i%ω@␂ρ␊",
  ],
  [EncodeRightSpace, " ", "␠"],
  [
    EncodeSlash | EncodeRightSpace,
    '␑>␒ｚ␌ｏｓσ\x0fζ X"#)η8ρ␉#λ1\v]＾ο9␍＞ｚ',
    '␑>␒ｚ␌ｏｓσ\x0fζ X"#)η8ρ␉#λ1\v]＾ο9␍＞ｚ',
  ],
  [
    EncodeSingleQuote | EncodeRightSpace,
    "\rＫi2\rI^ξ␊% \x19ιｅγγ␆３ηｈ\x0f␍␀７ψcＫ␋{␎",
    "\rＫi2\rI^ξ␊% \x19ιｅγγ␆３ηｈ\x0f␍‛␀７ψcＫ␋{␎",
  ],
  [
    EncodeBackQuote | EncodeRightSpace,
    'nｒ"@β／ｃOρ～ \x16␐κκ␍gｒ␒\x19\r\x1d％６Q5ζυ\x1c␈',
    'nｒ"@β／ｃOρ～ \x16␐κκ␍gｒ␒\x19\r\x1d％６Q5ζυ\x1c␈',
  ],
  [
    EncodeLtGt | EncodeRightSpace,
    '＠ｂφη;␈fＬlＣ φ［γZ＄␚＞＊:α,："ι{,\v｜\x01',
    '＠ｂφη;␈fＬlＣ φ［γZ＄␚‛＞＊:α,："ι{,\v｜\x01',
  ],
  [
    EncodeSquareBracket | EncodeRightSpace,
    "＊ｔ\n1\r｜χ␞［\x16 ;9ｐgδωυ`Fｆｃ％χ＃｜\x16ｌS<",
    "＊ｔ\n1\r｜χ␞‛［\x16 ;9ｐgδωυ`Fｆｃ％χ＃｜\x16ｌS<",
  ],
  [
    EncodeSemicolon | EncodeRightSpace,
    "␆\x05?␞w<\fσ␇５ sκω／；H␉␐－ξUφλ_＼p｜９>",
    "␆\x05?␞w<\fσ␇５ sκω／‛；H␉␐－ξUφλ_＼p｜９>",
  ],
  [
    EncodeExclamation | EncodeRightSpace,
    "\t０｜\x11ｏ\vςδjＰ πξ；DE␐9\x18η9＝［\x1cU\x1e␏ν［ｈ",
    "\t０｜\x11ｏ\vςδjＰ πξ；DE␐9\x18η9＝［\x1cU\x1e␏ν［ｈ",
  ],
  [
    EncodeDollar | EncodeRightSpace,
    "－ς\tIＮ␎？＼ζ｀ 6＠?：nW␅τTι\x19？␑␇!!κθ\x01",
    "－ς\tIＮ␎？＼ζ｀ 6＠?：nW␅τTι\x19？␑␇!!κθ\x01",
  ],
  [
    EncodeDoubleQuote | EncodeRightSpace,
    "␝IVｅ0%\x7f３κｅ !\x0fθζυ␟／＃：ＦπUβＧ␌\x1ee\x12\x01",
    "␝IVｅ0%\x7f３κｅ !\x0fθζυ␟／＃：ＦπUβＧ␌\x1ee\x12\x01",
  ],
  [
    EncodeColon | EncodeRightSpace,
    ":］χJｎＴ:η［ε ο\n~\x06␒Ｕ＊pι␒p␙＆\vＥ`.ι␗",
    "：］χJｎＴ：η［ε ο\n~\x06␒Ｕ＊pι␒p␙＆\vＥ`.ι␗",
  ],
  [
    EncodeQuestion | EncodeRightSpace,
    'Ｕ\x15＋＆υ␡／\x1bμς # π␘|z"／\x19ｙＥ␉\x00␉ａσ,{*',
    'Ｕ\x15＋＆υ␡／\x1bμς # π␘|z"／\x19ｙＥ␉␀␉ａσ,{*',
  ],
  [
    EncodeAsterisk | EncodeRightSpace,
    "＞ｔＴm␁\x18Yεσ１ ␎6\x10！＜]E␌␊␀2eρ\fｌγ\rχγ",
    "＞ｔＴm␁\x18Yεσ１ ␎6\x10！＜]E␌␊‛␀2eρ\fｌγ\rχγ",
  ],
  [
    EncodePipe | EncodeRightSpace,
    "６\x02Lς\x1cλＥ\x05<\x05 ：␎γν^␕&ｑ\r␅*χ４ψo␉０␖\x15",
    "６\x02Lς\x1cλＥ\x05<\x05 ：␎γν^␕&ｑ\r␅*χ４ψo␉０␖\x15",
  ],
  [
    EncodeHash | EncodeRightSpace,
    "γ␍｀θβζ\x7f/␔O Kω\x14?␋\x0e～Ｉ\x16;>ψ＄poＢ␏）Ｋ",
    "γ␍｀θβζ\x7f/␔O Kω\x14?␋\x0e～Ｉ\x16;>ψ＄poＢ␏）Ｋ",
  ],
  [
    EncodePercent | EncodeRightSpace,
    "-μ␁Ｅζi`/Ｕ? ␊Ｕ\x18␚␇gZππ１β\x1f*；Vθ␅PＦ",
    "-μ␁Ｅζi`/Ｕ? ␊Ｕ\x18␚␇gZππ１β\x1f*；Vθ␅PＦ",
  ],
  [
    EncodeBackSlash | EncodeRightSpace,
    '␛\\Rς␟\x14%θＴω ｒ\f；b"yε%:␔\x06␘５ｃδ/␓ａｕ',
    '␛＼Rς␟\x14%θＴω ｒ\f；b"yε%:␔\x06␘５ｃδ/␓ａｕ',
  ],
  [
    EncodeCrLf | EncodeRightSpace,
    "␊３␜h\\\vＺσθ］ \x13'＂<ｈ［Ｙσ␂\v`ｌθυτ＞|aL",
    "‛␊３␜h\\\vＺσθ］ \x13'＂<ｈ［Ｙσ␂\v`ｌθυτ＞|aL",
  ],
  [
    EncodeDel | EncodeRightSpace,
    "4β％␝ｈ．␘;!C `π␊␐υ＼\x18：\\ςｐ\x07q`θ％｜\r>",
    "4β％␝ｈ．␘;!C `π␊␐υ＼\x18：\\ςｐ\x07q`θ％｜\r>",
  ],
  [
    EncodeCtl | EncodeRightSpace,
    "ｑ\rＣ!#－?rβｖ ς%␘␅δ＊θ␇σ␡␌%π4nS！ｆ+",
    "ｑ␍Ｃ!#－?rβｖ ς%‛␘‛␅δ＊θ‛␇σ␡‛␌%π4nS！ｆ+",
  ],
  [EncodeRightPeriod, ".", "．"],
  [
    EncodeSlash | EncodeRightPeriod,
    ":［\x1e44νS\\!y.ｄκ［η\x0e；Ｚ｛ｏ␊α␊ς␇λf］ｙ[",
    ":［\x1e44νS\\!y.ｄκ［η\x0e；Ｚ｛ｏ␊α␊ς␇λf］ｙ[",
  ],
  [
    EncodeSingleQuote | EncodeRightPeriod,
    "（;ηＦυ＞ν␘+＄.o\x12ｙ％\x05D？2ψ\x15H［ζι␚\x18␍＜\x1e",
    "（;ηＦυ＞ν␘+＄.o\x12ｙ％\x05D？2ψ\x15H［ζι␚\x18␍＜\x1e",
  ],
  [
    EncodeBackQuote | EncodeRightPeriod,
    "β$bUτＤ|／}\x1e.ｐ␅；]χD␖＜4␄\x07ｍ\x12ｄＬνε\x1cφ",
    "β$bUτＤ|／}\x1e.ｐ␅；]χD␖＜4␄\x07ｍ\x12ｄＬνε\x1cφ",
  ],
  [
    EncodeLtGt | EncodeRightPeriod,
    "＠#＂␊\x1cｈθｂGχ.␑Ｖςα␐L\x13ｍ\f1;μ␇2_\x1e|ｋ␜",
    "＠#＂␊\x1cｈθｂGχ.␑Ｖςα␐L\x13ｍ\f1;μ␇2_\x1e|ｋ␜",
  ],
  [
    EncodeSquareBracket | EncodeRightPeriod,
    "#\x1cα＇\x13θ！＞ κ.␅［uε\x17１，ｗ0＼＇７θJ\x7f}\x18}％",
    "#\x1cα＇\x13θ！＞ κ.␅‛［uε\x17１，ｗ0＼＇７θJ\x7f}\x18}％",
  ],
  [
    EncodeSemicolon | EncodeRightPeriod,
    "␆λu！ξＳf\x02:␆.θχＳ＝}＄η␏ｘ[:ｒ[\x1f\nοfＲJ",
    "␆λu！ξＳf\x02:␆.θχＳ＝}＄η␏ｘ[:ｒ[\x1f\nοfＲJ",
  ],
  [
    EncodeExclamation | EncodeRightPeriod,
    "␀␆βο\\%\x180ς:.3οk＆ｐｒDg\x1dＵ␎\tI＇␊␀κＨｅ",
    "‛␀␆βο\\%\x180ς:.3οk＆ｐｒDg\x1dＵ␎\tI＇␊‛␀κＨｅ",
  ],
  [
    EncodeDollar | EncodeRightPeriod,
    "␖[ηυz\v␒/｛␛.βｎ!L␅MK\x17\nNＡRλ５＂δ␏σＵ",
    "␖[ηυz\v␒/｛␛.βｎ!L␅MK\x17\nNＡRλ５＂δ␏σＵ",
  ],
  [
    EncodeDoubleQuote | EncodeRightPeriod,
    "βｉB＼␙\x15␙；η].~λｃ>σ␓\x05ωcｙｖθ␌％_k＃h\v",
    "βｉB＼␙\x15␙；η].~λｃ>σ␓\x05ωcｙｖθ␌％_k＃h\v",
  ],
  [
    EncodeColon | EncodeRightPeriod,
    "z\x1aｐ？%［iｕ\vx.␆␍α）␉［^γＣ;κ\x11␜β］ηζ'\x12",
    "z\x1aｐ？%［iｕ\vx.␆␍α）␉［^γＣ;κ\x11␜β］ηζ'\x12",
  ],
  [
    EncodeQuestion | EncodeRightPeriod,
    "\x1cD％␎|βκθυS.\x1eｍτ␆\x1f\bK\b\f＊Ｐ＠＝␊Ｂη＞_＜",
    "\x1cD％␎|βκθυS.\x1eｍτ␆\x1f\bK\b\f＊Ｐ＠＝␊Ｂη＞_＜",
  ],
  [
    EncodeAsterisk | EncodeRightPeriod,
    "y＇｀\x7fθ\x1cｅ␔Ｑ\x13.tb\x02\x19ξ，＋%ξ␍␏;␅ζρ=νＳT",
    "y＇｀\x7fθ\x1cｅ␔Ｑ\x13.tb\x02\x19ξ，＋%ξ␍␏;␅ζρ=νＳT",
  ],
  [
    EncodePipe | EncodeRightPeriod,
    "xφ：［!\x00Ｊ;λ␉.６ζ7;qＺ＆？ω␔␏\nςｖ\r！(σ;",
    "xφ：［!␀Ｊ;λ␉.６ζ7;qＺ＆？ω␔␏\nςｖ\r！(σ;",
  ],
  [
    EncodeHash | EncodeRightPeriod,
    "/␁｝\x13␂）y\x04D＂.U&ｆ\x16␞\nω␔\x05φｓ２ν␋<χψγ５",
    "/␁｝\x13␂）y\x04D＂.U&ｆ\x16␞\nω␔\x05φｓ２ν␋<χψγ５",
  ],
  [
    EncodePercent | EncodeRightPeriod,
    "ααyς␘\x13␟Rι＜.Ｇχｇｉ\r␊κ6\x18Y>RＤ␒ｂ␔Ｃ\x1b\x1a",
    "ααyς␘\x13␟Rι＜.Ｇχｇｉ\r␊κ6\x18Y>RＤ␒ｂ␔Ｃ\x1b\x1a",
  ],
  [
    EncodeBackSlash | EncodeRightPeriod,
    "␗％\x00*η\x0e：ισ*.:P:f[ｋｚＣ％３］<βＧξςN｀␃",
    "␗％␀*η\x0e：ισ*.:P:f[ｋｚＣ％３］<βＧξςN｀␃",
  ],
  [
    EncodeCrLf | EncodeRightPeriod,
    "ρＭＲ␑DπwＳ＄\x03.B␝␁$␇λβ␜␀λ$ιG\n$\rｄｓ\b",
    "ρＭＲ␑DπwＳ＄\x03.B␝␁$␇λβ␜‛␀λ$ιG␊$␍ｄｓ\b",
  ],
  [
    EncodeDel | EncodeRightPeriod,
    "［y`ο␛υ^\n\x1d：.！υ＜\x16＝\nμ\x02βＩｊ!］＇~;５＼τ",
    "［y`ο␛υ^\n\x1d：.！υ＜\x16＝\nμ\x02βＩｊ!］＇~;５＼τ",
  ],
  [
    EncodeCtl | EncodeRightPeriod,
    "\x11␌＞β␔#'ｗσ０.a@jａφ␔τvFＭκ␡ τ；ｌ\x0fｍ\x16",
    "␑‛␌＞β‛␔#'ｗσ０.a@jａφ‛␔τvFＭκ␡ τ；ｌ␏ｍ␖",
  ],
  [EncodeRightCrLfHtVt, "\t", "␉"],
  [
    EncodeSlash | EncodeRightCrLfHtVt,
    "H␅χＵQ␋Ａ␔ωχ\t\nοε\x0eＫｍ\x02␁|Ａ／|υ．␅go\x1c\v",
    "H␅χＵQ␋Ａ␔ωχ\t\nοε\x0eＫｍ\x02␁|Ａ‛／|υ．␅go\x1c␋",
  ],
  [
    EncodeSingleQuote | EncodeRightCrLfHtVt,
    "｜＆␃␄；\x02＞ζfχ\t，<υτc`τ␞2[６＃％n\rθ\x02`>",
    "｜＆␃␄；\x02＞ζfχ\t，<υτc`τ␞2[６＃％n\rθ\x02`>",
  ],
  [
    EncodeBackQuote | EncodeRightCrLfHtVt,
    "＇β［／\x15␗＝␇\x11&\t＇ςＡβG+\x04␃\x12␝\x03\rwO$τς␆＃",
    "＇β［／\x15␗＝␇\x11&\t＇ςＡβG+\x04␃\x12␝\x03\rwO$τς␆＃",
  ],
  [
    EncodeLtGt | EncodeRightCrLfHtVt,
    "\x16 ␟ζ8ｋｓζ［？\t\x1c＄Ｘ：␅0ω＂$φ＞\x1eκ\x1f:%｛\x04Q",
    "\x16 ␟ζ8ｋｓζ［？\t\x1c＄Ｘ：␅0ω＂$φ‛＞\x1eκ\x1f:%｛\x04Q",
  ],
  [
    EncodeSquareBracket | EncodeRightCrLfHtVt,
    "j：：Wχ;χ４\x047\tιｃ␞ψ␃Ａβ␀\x0e！ＴhX\x03Z＜`＆\x01",
    "j：：Wχ;χ４\x047\tιｃ␞ψ␃Ａβ‛␀\x0e！ＴhX\x03Z＜`＆\x01",
  ],
  [
    EncodeSemicolon | EncodeRightCrLfHtVt,
    "iｆpX.\x03ηａ＇␍\tＰορ␑λ?%\r&␋ＧρＺ␑\x16２\bkμ",
    "iｆpX.\x03ηａ＇␍\tＰορ␑λ?%\r&␋ＧρＺ␑\x16２\bkμ",
  ],
  [
    EncodeExclamation | EncodeRightCrLfHtVt,
    "ｅ.＇\x00B␗(πｕ$\t％␆μα［Ｆｃ&０β[＊\rςξＳ\x01\b\\",
    "ｅ.＇␀B␗(πｕ$\t％␆μα［Ｆｃ&０β[＊\rςξＳ\x01\b\\",
  ],
  [
    EncodeDollar | EncodeRightCrLfHtVt,
    '＂<｀Q/κ#θ"␐\t\x17［%␜Ｎ␊Ｂ:；？:␁φξν|y5μ',
    '＂<｀Q/κ#θ"␐\t\x17［%␜Ｎ␊Ｂ:；？:␁φξν|y5μ',
  ],
  [
    EncodeDoubleQuote | EncodeRightCrLfHtVt,
    "$&！\x16％\x06δ%~ω\t｀β\x1b/ψe␁v／τ#ν［：）␕Ｂｗ␅",
    "$&！\x16％\x06δ%~ω\t｀β\x1b/ψe␁v／τ#ν［：）␕Ｂｗ␅",
  ],
  [
    EncodeColon | EncodeRightCrLfHtVt,
    "φ*Ｕε\x04,\x05ｖ␘＼\t?␇τσ#（␉␊\x0fφ␐I/;ｎｏ\x18ＰV",
    "φ*Ｕε\x04,\x05ｖ␘＼\t?␇τσ#（␉␊\x0fφ␐I/;ｎｏ\x18ＰV",
  ],
  [
    EncodeQuestion | EncodeRightCrLfHtVt,
    "␆Ｂ\x11\x0eｋ\\=␉ｍψ\tπ\x19␉(␊y`）σ\x1aυＺyFπw␂␊＇",
    "␆Ｂ\x11\x0eｋ\\=␉ｍψ\tπ\x19␉(␊y`）σ\x1aυＺyFπw␂␊＇",
  ],
  [
    EncodeAsterisk | EncodeRightCrLfHtVt,
    "；Mα␗／␑υ:\x13；\tοａ\x16ｉ#␀＠y＂δ3!ρ｜AＴ]\x15[",
    "；Mα␗／␑υ:\x13；\tοａ\x16ｉ#‛␀＠y＂δ3!ρ｜AＴ]\x15[",
  ],
  [
    EncodePipe | EncodeRightCrLfHtVt,
    "$γιＺ２ｑ␡\x04ｎ␋\t\x11\b1ζ\x17？ｌ,ςｏκ␆Pρ｀\t!)␝",
    "$γιＺ２ｑ␡\x04ｎ␋\t\x11\b1ζ\x17？ｌ,ςｏκ␆Pρ｀\t!)␝",
  ],
  [
    EncodeHash | EncodeRightCrLfHtVt,
    "\x16#tψｐ␎␊ｏ$χ\t␗ｐ％ω␡/μ\tb３Ｓ␁T８\x154νG\f",
    "\x16＃tψｐ␎␊ｏ$χ\t␗ｐ％ω␡/μ\tb３Ｓ␁T８\x154νG\f",
  ],
  [
    EncodePercent | EncodeRightCrLfHtVt,
    '␒+/ｖ␡␄ｈθ８[\t)＊ｃ"χω0␇γZχp\x15ｇ␎χi\x11\x15',
    '␒+/ｖ␡␄ｈθ８[\t)＊ｃ"χω0␇γZχp\x15ｇ␎χi\x11\x15',
  ],
  [
    EncodeBackSlash | EncodeRightCrLfHtVt,
    "*＼π\"１Ｋ␖＼Hｐ\t`τςN\x14ω␏␝'λ\n\x1d2ｄHF␗Ｂｈ",
    "*‛＼π\"１Ｋ␖‛＼Hｐ\t`τςN\x14ω␏␝'λ\n\x1d2ｄHF␗Ｂｈ",
  ],
  [
    EncodeDel | EncodeRightCrLfHtVt,
    "］３ιφ*，?]\x0fυ\t％dX)Sγω／<␂\uff00␋\x07２\n\r␅␈δ",
    "］３ιφ*，?]\x0fυ\t％dX)Sγω／<␂\uff00␋\x07２\n\r␅␈δ",
  ],
  [EncodeLeftSpace | EncodeRightPeriod, " .", "␠．"],
  [EncodeLeftSpace | EncodeRightSpace, " ", "␠"],
  [EncodeLeftPeriod | EncodeRightPeriod, "...", "．.．"],
  [EncodeRightPeriod | EncodeRightSpace, "a. ", "a.␠"],
];

const DOUBLE_EDGE = [
  [
    EncodeZero | EncodeLeftSpace | EncodeLeftPeriod,
    ' .／ｌｃ６>"␃@οκｖ\tu␀#Ｔκ␉\n＞E\x0eW＃gχ.π',
    '␠.／ｌｃ６>"␃@οκｖ\tu‛␀#Ｔκ␉\n＞E\x0eW＃gχ.π',
  ],
  [
    EncodeSlash | EncodeLeftSpace | EncodeLeftPeriod,
    " .\n\x1eδＶ2␀t；!␐ＫＯsφ\x7fＱ␛@？'\x03␔σξＹs.｝",
    "␠.\n\x1eδＶ2‛␀t；!␐ＫＯsφ\x7fＱ␛@？'\x03␔σξＹs.｝",
  ],
  [
    EncodeSingleQuote | EncodeLeftSpace | EncodeLeftPeriod,
    " .ｘ：$ξ|␋m＂γ！５A\x07\x19ｌ：␀ε\x01Gμ␃υW␈A.ｏ",
    "␠.ｘ：$ξ|␋m＂γ！５A\x07\x19ｌ：‛␀ε\x01Gμ␃υW␈A.ｏ",
  ],
  [
    EncodeBackQuote | EncodeLeftSpace | EncodeLeftPeriod,
    " .I\x00＝｝σ＃π＂#＿>?\x17\x18␁␄＇;οh␃Ｘ\x0es／+.９",
    "␠.I␀＝｝σ＃π＂#＿>?\x17\x18␁␄＇;οh␃Ｘ\x0es／+.９",
  ],
  [
    EncodeLtGt | EncodeLeftSpace | EncodeLeftPeriod,
    " .␀ζWγ}ａ\x18<#χ]ψβ␘＞\x13␗＝M␘λ\"：%␘#.'",
    "␠.‛␀ζWγ}ａ\x18＜#χ]ψβ␘‛＞\x13␗＝M␘λ\"：%␘#.'",
  ],
  [
    EncodeSquareBracket | EncodeLeftSpace | EncodeLeftPeriod,
    ' .ασs$␖ＮXπ\x06｜ＥUm？χＹη␓；"␟Ｈ\bDι\x16.\t',
    '␠.ασs$␖ＮXπ\x06｜ＥUm？χＹη␓；"␟Ｈ\bDι\x16.\t',
  ],
  [
    EncodeSemicolon | EncodeLeftSpace | EncodeLeftPeriod,
    " .\vγ.p>\\ρ－η}␄Ｉσ\x1eＤ<ｆο｜␃␀ζｖ␆ｉ／.h",
    "␠.\vγ.p>\\ρ－η}␄Ｉσ\x1eＤ<ｆο｜␃‛␀ζｖ␆ｉ／.h",
  ],
  [
    EncodeExclamation | EncodeLeftSpace | EncodeLeftPeriod,
    " .＼＼｜］ψ>6\x18５*\vδ\nυ^>１a％\x7fγψ［M\x01κ.ｕ",
    "␠.＼＼｜］ψ>6\x18５*\vδ\nυ^>１a％\x7fγψ［M\x01κ.ｕ",
  ],
  [
    EncodeDollar | EncodeLeftSpace | EncodeLeftPeriod,
    " .］γ]'）ς9φ␎＞\x04Ｈ\rW␏[s␅␊\x1cｃμ\x02，μ8.␓",
    "␠.］γ]'）ς9φ␎＞\x04Ｈ\rW␏[s␅␊\x1cｃμ\x02，μ8.␓",
  ],
  [
    EncodeDoubleQuote | EncodeLeftSpace | EncodeLeftPeriod,
    " .␕%ι?ｇ＼.／θ$ｕγ／αν\x06%␈HιJＷU\x0e\x16^.～",
    "␠.␕%ι?ｇ＼.／θ$ｕγ／αν\x06%␈HιJＷU\x0e\x16^.～",
  ],
  [
    EncodeColon | EncodeLeftSpace | EncodeLeftPeriod,
    " .Ｑμ>５γＪ\x00μ␍Ｗ␙␁Su␛mJ\x18ςsＳβ\x05[λＸ.g",
    "␠.Ｑμ>５γＪ␀μ␍Ｗ␙␁Su␛mJ\x18ςsＳβ\x05[λＸ.g",
  ],
  [
    EncodeQuestion | EncodeLeftSpace | EncodeLeftPeriod,
    " .Iｈ\x07８！$ψ＄N％τｆ␘ρ｀\x1d\x7f\x1bςς{␋５␖\x11<.［",
    "␠.Iｈ\x07８！$ψ＄N％τｆ␘ρ｀\x1d\x7f\x1bςς{␋５␖\x11<.［",
  ],
  [
    EncodeAsterisk | EncodeLeftSpace | EncodeLeftPeriod,
    " .ｂ)ω［＂α\x06$\v\x1cｕ｜!ｒοV␉ηφ?ｄ｜ε␀＾?.␝",
    "␠.ｂ)ω［＂α\x06$\v\x1cｕ｜!ｒοV␉ηφ?ｄ｜ε‛␀＾?.␝",
  ],
  [
    EncodePipe | EncodeLeftSpace | EncodeLeftPeriod,
    " .␍␚␇\x04\x05％\tςχζ?W␆ＴL｛ρωπI0Ｎ>fL\x0e.ｇ",
    "␠.␍␚␇\x04\x05％\tςχζ?W␆ＴL｛ρωπI0Ｎ>fL\x0e.ｇ",
  ],
  [
    EncodeHash | EncodeLeftSpace | EncodeLeftPeriod,
    " .ｒδI\t\x7fuδＤ3ω␙ｇY\b１σ\x15γ␞e*\x06␘＼ω␃.Ｘ",
    "␠.ｒδI\t\x7fuδＤ3ω␙ｇY\b１σ\x15γ␞e*\x06␘＼ω␃.Ｘ",
  ],
  [
    EncodePercent | EncodeLeftSpace | EncodeLeftPeriod,
    " .κ＜＼␈\x15\x0f］\x15ερ：，τＸq␒eC␛\x1bｚ.G！ｓ\v.J",
    "␠.κ＜＼␈\x15\x0f］\x15ερ：，τＸq␒eC␛\x1bｚ.G！ｓ\v.J",
  ],
  [
    EncodeBackSlash | EncodeLeftSpace | EncodeLeftPeriod,
    " .ρ！Ｘβ␄1␕ＯfM␍Ｂ/\x07\x14ωMηｂ#ο％\x06，ε:.ｋ",
    "␠.ρ！Ｘβ␄1␕ＯfM␍Ｂ/\x07\x14ωMηｂ#ο％\x06，ε:.ｋ",
  ],
  [
    EncodeCrLf | EncodeLeftSpace | EncodeLeftPeriod,
    " .\vχ\x13ω；．λ＜／3pS␚τ\vＷ␂ｈρEγ｜␗ＸＳq.\x19",
    "␠.\vχ\x13ω；．λ＜／3pS␚τ\vＷ␂ｈρEγ｜␗ＸＳq.\x19",
  ],
  [
    EncodeDel | EncodeLeftSpace | EncodeLeftPeriod,
    " .#＄υ␈dλＺ,\vωｚ\x18Ｋ！\v＃ςL｜＊\x0f:␙οτ＃.\x1b",
    "␠.#＄υ␈dλＺ,\vωｚ\x18Ｋ！\v＃ςL｜＊\x0f:␙οτ＃.\x1b",
  ],
  [
    EncodeCtl | EncodeLeftSpace | EncodeLeftPeriod,
    " .Ｓτ␉lSOγ␑\x01ψ\x11８＾␟］γ~>Lκηc\n\x1f｀Ｙ.＄",
    "␠.Ｓτ‛␉lSOγ‛␑␁ψ␑８＾‛␟］γ~>Lκηc␊␟｀Ｙ.＄",
  ],
  [
    EncodeZero | EncodeLeftSpace | EncodeLeftTilde,
    " ~r7φλQ｜Ｑ＜␃ρ␊\x1e\x0fu＊\uff00＊␚～␛ζ!\x1f\x16;ψ~ｚ",
    "␠~r7φλQ｜Ｑ＜␃ρ␊\x1e\x0fu＊\uff00＊␚～␛ζ!\x1f\x16;ψ~ｚ",
  ],
  [
    EncodeSlash | EncodeLeftSpace | EncodeLeftTilde,
    " ~ＰY%yＣ=［＿ς\x1c␀８\x1e␊\bbＪψ\x13␊\x18ςτ␔/J~ο",
    "␠~ＰY%yＣ=［＿ς\x1c‛␀８\x1e␊\bbＪψ\x13␊\x18ςτ␔／J~ο",
  ],
  [
    EncodeSingleQuote | EncodeLeftSpace | EncodeLeftTilde,
    " ~ψκ.␕ω␛\x05␝z＃ν\rＫ|}ＷＭ␇\b\x11␄.３／αδ~]",
    "␠~ψκ.␕ω␛\x05␝z＃ν\rＫ|}ＷＭ␇\b\x11␄.３／αδ~]",
  ],
  [
    EncodeBackQuote | EncodeLeftSpace | EncodeLeftTilde,
    " ~＃？οβ＊Ａα＂kgＫ＼λj!␊\x17θ＿:\x1c\x04\x1b␝Y␅~\x7f",
    "␠~＃？οβ＊Ａα＂kgＫ＼λj!␊\x17θ＿:\x1c\x04\x1b␝Y␅~\x7f",
  ],
  [
    EncodeLtGt | EncodeLeftSpace | EncodeLeftTilde,
    " ~αξ／\x02\x06０␕2［␍ｖ＜\x11\x1e␃`ξt`/，κ>｝/@~σ",
    "␠~αξ／\x02\x06０␕2［␍ｖ‛＜\x11\x1e␃`ξt`/，κ＞｝/@~σ",
  ],
  [
    EncodeSquareBracket | EncodeLeftSpace | EncodeLeftTilde,
    " ~ｑy：X'\x00␉｜O\x15>\r'ｎα!␂␉$（＂<βγ␜ζ~７",
    "␠~ｑy：X'␀␉｜O\x15>\r'ｎα!␂␉$（＂<βγ␜ζ~７",
  ],
  [
    EncodeSemicolon | EncodeLeftSpace | EncodeLeftTilde,
    " ~␔$＊ｓｚφJζ#␁Eη9␌οτ?αHc/，Ｇｋ＃\r~␐",
    "␠~␔$＊ｓｚφJζ#␁Eη9␌οτ?αHc/，Ｇｋ＃\r~␐",
  ],
  [
    EncodeExclamation | EncodeLeftSpace | EncodeLeftTilde,
    " ~ｓωｃδσF］/！％９␡[φd\rｋςｗ␔b|\x14G2＇~ξ",
    "␠~ｓωｃδσF］/‛！％９␡[φd\rｋςｗ␔b|\x14G2＇~ξ",
  ],
  [
    EncodeDollar | EncodeLeftSpace | EncodeLeftTilde,
    " ~!l␍\x04]βXγ－␃Ｋ␗␑>l３φ␉\x07βｑ＇φ１σ+~\n",
    "␠~!l␍\x04]βXγ－␃Ｋ␗␑>l３φ␉\x07βｑ＇φ１σ+~\n",
  ],
  [
    EncodeDoubleQuote | EncodeLeftSpace | EncodeLeftTilde,
    " ~：\rｍ%／\x14␆］ｍβ␄␌A？θａ9ν|>RAkςο␟~\r",
    "␠~：\rｍ%／\x14␆］ｍβ␄␌A？θａ9ν|>RAkςο␟~\r",
  ],
  [
    EncodeColon | EncodeLeftSpace | EncodeLeftTilde,
    " ~ｌ7Ｕv＇H\x15＋t＊！Ｓβω\r>␉␗ζυξ\x0eX\x7f\f␄~\x1f",
    "␠~ｌ7Ｕv＇H\x15＋t＊！Ｓβω\r>␉␗ζυξ\x0eX\x7f\f␄~\x1f",
  ],
  [
    EncodeQuestion | EncodeLeftSpace | EncodeLeftTilde,
    " ~Uuｊ␓`␕␉＝τP␉ｕο\x14Ｘ\x10\v／βγ'!＼ξ}L~η",
    "␠~Uuｊ␓`␕␉＝τP␉ｕο\x14Ｘ\x10\v／βγ'!＼ξ}L~η",
  ],
  [
    EncodeAsterisk | EncodeLeftSpace | EncodeLeftTilde,
    " ~␗ω：＇Ｆ␋|＇＞␓]νεｅｗＦ*\x1e>};%θγ~N~Ｄ",
    "␠~␗ω：＇Ｆ␋|＇＞␓]νεｅｗＦ＊\x1e>};%θγ~N~Ｄ",
  ],
  [
    EncodePipe | EncodeLeftSpace | EncodeLeftTilde,
    " ~␁\x18κP~␉ＱsＩτ<ｋ␘ｐωξ/A＂Ｖ［v'α␐5~␃",
    "␠~␁\x18κP~␉ＱsＩτ<ｋ␘ｐωξ/A＂Ｖ［v'α␐5~␃",
  ],
  [
    EncodeHash | EncodeLeftSpace | EncodeLeftTilde,
    " ~Cν?\\＼\x03ψ␂Ｎς＂j＞/`\x12ψN\nπＬ␐␂[｛］~σ",
    "␠~Cν?\\＼\x03ψ␂Ｎς＂j＞/`\x12ψN\nπＬ␐␂[｛］~σ",
  ],
  [
    EncodePercent | EncodeLeftSpace | EncodeLeftTilde,
    " ~μ␘＂zL`\x19θοε８␚␙Ｗβ＄\r/μLoｍ'％Ｋz~8",
    "␠~μ␘＂zL`\x19θοε８␚␙Ｗβ＄\r/μLoｍ'‛％Ｋz~8",
  ],
  [
    EncodeBackSlash | EncodeLeftSpace | EncodeLeftTilde,
    " ~!γＶIｆκ␜｛EＬπＪ␐2\x7fＶζφ＇␂|gPι'\r~␍",
    "␠~!γＶIｆκ␜｛EＬπＪ␐2\x7fＶζφ＇␂|gPι'\r~␍",
  ],
  [
    EncodeCrLf | EncodeLeftSpace | EncodeLeftTilde,
    " ~ζｌE$dBι｜`␒ｄ＇tｇ␅％*ο？φβψx％］\v~␞",
    "␠~ζｌE$dBι｜`␒ｄ＇tｇ␅％*ο？φβψx％］\v~␞",
  ],
  [
    EncodeDel | EncodeLeftSpace | EncodeLeftTilde,
    " ~８)D/\bｍν\\］bε␗'\nξ}Ｔ␊：ｆτ␛␋ｕ?λ~κ",
    "␠~８)D/\bｍν\\］bε␗'\nξ}Ｔ␊：ｆτ␛␋ｕ?λ~κ",
  ],
  [
    EncodeCtl | EncodeLeftSpace | EncodeLeftTilde,
    " ~`－：／␆μδL］␏τ｀%Ｒ[n␔γ\rZ＼:μ｛\x18S~/",
    "␠~`－：／‛␆μδL］‛␏τ｀%Ｒ[n‛␔γ␍Z＼:μ｛␘S~/",
  ],
  [
    EncodeZero | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    ' \t＄ｘ/$｀Frη`|］＝␇␝λ\x1bδ\x12ζ"␋␊υ；\tW\t＊',
    '␠\t＄ｘ/$｀Frη`|］＝␇␝λ\x1bδ\x12ζ"␋␊υ；\tW\t＊',
  ],
  [
    EncodeSlash | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \tｃ［ι\x01'ιｆ[｝eG｝␝Aηψκ\x12␛＂\f{＊␅／/\ty",
    "␠\tｃ［ι\x01'ιｆ[｝eG｝␝Aηψκ\x12␛＂\f{＊␅‛／／\ty",
  ],
  [
    EncodeSingleQuote | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    ' \t"\x1a＇7>＝＜sιθ４\x14\x17g␉^␓␂_ιｇγ！Ｊ␙ο\tG',
    '␠\t"\x1a‛＇7>＝＜sιθ４\x14\x17g␉^␓␂_ιｇγ！Ｊ␙ο\tG',
  ],
  [
    EncodeBackQuote | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \t｀<Ｓ\uff009}\rξυ␛＂θλ[/\x19$Ｏ９f␑␏τ?P&\t７",
    "␠\t‛｀<Ｓ\uff009}\rξυ␛＂θλ[/\x19$Ｏ９f␑␏τ?P&\t７",
  ],
  [
    EncodeLtGt | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \t\r␁ο\x06/␚Ｌ］8Ｈ{＞C3φＶφ␛O＇α＞０\\\x14\x0e\tψ",
    "␠\t\r␁ο\x06/␚Ｌ］8Ｈ{‛＞C3φＶφ␛O＇α‛＞０\\\x14\x0e\tψ",
  ],
  [
    EncodeSquareBracket | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \tελ\x07iN␝３7#Z］ｃ[^／ε＿␔␀␂?␚χＦς\x19\t\r",
    "␠\tελ\x07iN␝３7#Z‛］ｃ［^／ε＿␔‛␀␂?␚χＦς\x19\t\r",
  ],
  [
    EncodeSemicolon | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \ts\tb｜␑ν）␗k(π␜，A!Ｄ\uff00\x1c２\x7f|\x07＼αο\x14\tζ",
    "␠\ts\tb｜␑ν）␗k(π␜，A!Ｄ\uff00\x1c２\x7f|\x07＼αο\x14\tζ",
  ],
  [
    EncodeExclamation | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \tγ＞␁Ｂ＊３␌␆\v２＼\x1dκ<τｖＭc<&<BWκσρ\t`",
    "␠\tγ＞␁Ｂ＊３␌␆\v２＼\x1dκ<τｖＭc<&<BWκσρ\t`",
  ],
  [
    EncodeDollar | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \t＼＼\v\f！FXι␉␏＞ς\x0f\x1aε␛%ζＮ_Iγ'Ｈmγ\t＜",
    "␠\t＼＼\v\f！FXι␉␏＞ς\x0f\x1aε␛%ζＮ_Iγ'Ｈmγ\t＜",
  ],
  [
    EncodeDoubleQuote | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \tς;\x10\vq＞^ξ＼␓␎␑\v％Ｉο%７'ａ[1Ｐφακ\t]",
    "␠\tς;\x10\vq＞^ξ＼␓␎␑\v％Ｉο%７'ａ[1Ｐφακ\t]",
  ],
  [
    EncodeColon | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \tｐ＋ξ.\\\x13７４@ρ%＼␅␟␛χν[Ｐ␍ψ:\x0f9oο\t'",
    "␠\tｐ＋ξ.\\\x13７４@ρ%＼␅␟␛χν[Ｐ␍ψ：\x0f9oο\t'",
  ],
  [
    EncodeQuestion | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    ' \tf．`Ｃ！φ\fιｉ\n/υ\x1ey␆ζ％"％%3ｋ␘\x15ιT\t␐',
    '␠\tf．`Ｃ！φ\fιｉ\n/υ\x1ey␆ζ％"％%3ｋ␘\x15ιT\t␐',
  ],
  [
    EncodeAsterisk | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \t/ακ＊[！3＄␘δ\x0e␝\r␍b\x154␏\v␘y：Ｔβγε\t２",
    "␠\t/ακ‛＊[！3＄␘δ\x0e␝\r␍b\x154␏\v␘y：Ｔβγε\t２",
  ],
  [
    EncodePipe | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \tｍＣ␍μx＾\x13dοτ／Ｋξ\x14８/\x16\x1ab ～：Zν｀>\t＇",
    "␠\tｍＣ␍μx＾\x13dοτ／Ｋξ\x14８/\x16\x1ab ～：Zν｀>\t＇",
  ],
  [
    EncodeHash | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \t␊\t｝υ\r８>Z␒δ=\x14％＜｀：\x13ι`ＮFφq\x1aGδ\tｊ",
    "␠\t␊\t｝υ\r８>Z␒δ=\x14％＜｀：\x13ι`ＮFφq\x1aGδ\tｊ",
  ],
  [
    EncodePercent | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \t\x12ZＨ\x1aς>３．τ｀␕8γｄγ\\_9Ｋ\x1c'Z␘␕β'\t␞",
    "␠\t\x12ZＨ\x1aς>３．τ｀␕8γｄγ\\_9Ｋ\x1c'Z␘␕β'\t␞",
  ],
  [
    EncodeBackSlash | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \t\x17\x06?＂η~θ\x1d.｜D␕ｍζ１π？␡Ｏω␄＼␞\x16<␓\t\n",
    "␠\t\x17\x06?＂η~θ\x1d.｜D␕ｍζ１π？␡Ｏω␄‛＼␞\x16<␓\t\n",
  ],
  [
    EncodeDel | EncodeLeftSpace | EncodeLeftCrLfHtVt,
    " \t␟］6λ{j；＋/␆<\nξ/(␈σＩｒ/；δ－#Fχ\t：",
    "␠\t␟］6λ{j；＋/␆<\nξ/(␈σＩｒ/；δ－#Fχ\t：",
  ],
  [
    EncodeZero | EncodeLeftSpace | EncodeRightSpace,
    "  ｉTζ␌\x07８\vＥ;ｔς␕］vhα␆/\x10[eφ＞κｎ[ ␙",
    "␠ ｉTζ␌\x07８\vＥ;ｔς␕］vhα␆/\x10[eφ＞κｎ[ ␙",
  ],
  [
    EncodeSlash | EncodeLeftSpace | EncodeRightSpace,
    '  α␕@Zτｅ"λt\x0e\x02ς␊␜ε␜5␍{\x14Ｆmσ\x14␙Ｌ １',
    '␠ α␕@Zτｅ"λt\x0e\x02ς␊␜ε␜5␍{\x14Ｆmσ\x14␙Ｌ １',
  ],
  [
    EncodeSingleQuote | EncodeLeftSpace | EncodeRightSpace,
    "  ␈ｖ＂␐ψ\x18Qβｆq\\U␘|a!６ζ>φ␝Ｆｗ␌σx /",
    "␠ ␈ｖ＂␐ψ\x18Qβｆq\\U␘|a!６ζ>φ␝Ｆｗ␌σx /",
  ],
  [
    EncodeBackQuote | EncodeLeftSpace | EncodeRightSpace,
    "  #κ~␂␄␗a=γ＄α７χ\uff00Ｔ３I\x1cC'\x11Ｊ,／β\x04 '",
    "␠ #κ~␂␄␗a=γ＄α７χ\uff00Ｔ３I\x1cC'\x11Ｊ,／β\x04 '",
  ],
  [
    EncodeLtGt | EncodeLeftSpace | EncodeRightSpace,
    "  \x19\x0f␃ｎｗ\x00＼ε（η\n5`2\x10：␅＿XVη␙␁βτδ Ｐ",
    "␠ \x19\x0f␃ｎｗ␀＼ε（η\n5`2\x10：␅＿XVη␙␁βτδ Ｐ",
  ],
  [
    EncodeSquareBracket | EncodeLeftSpace | EncodeRightSpace,
    '  ｍκε6␇？s\x14ς7ψ%ζ@#[２＃\vｏ｀％A"ω7 ␉',
    '␠ ｍκε6␇？s\x14ς7ψ%ζ@#［２＃\vｏ｀％A"ω7 ␉',
  ],
  [
    EncodeSemicolon | EncodeLeftSpace | EncodeRightSpace,
    '  ＂2Y４α;πγ w｛ｇＫｙπ["［χβ␝\b␕\t\\␓ \n',
    '␠ ＂2Y４α；πγ w｛ｇＫｙπ["［χβ␝\b␕\t\\␓ \n',
  ],
  [
    EncodeExclamation | EncodeLeftSpace | EncodeRightSpace,
    "  \x05␜θ｜␞k'`␖ＷλＦ\r\rτta_η［／θω＂\x01ｈ s",
    "␠ \x05␜θ｜␞k'`␖ＷλＦ\r\rτta_η［／θω＂\x01ｈ s",
  ],
  [
    EncodeDollar | EncodeLeftSpace | EncodeRightSpace,
    "  ␁～＊␁］-8C＿２␕ω␑q'=?\x02␍νεｓ/｝\r> γ",
    "␠ ␁～＊␁］-8C＿２␕ω␑q'=?\x02␍νεｓ/｝\r> γ",
  ],
  [
    EncodeDoubleQuote | EncodeLeftSpace | EncodeRightSpace,
    "  ３\x02＄ｙλ[fＹY\x0e？πς␆［7Ｋ\r\x10␀ξκ␕I／e n",
    "␠ ３\x02＄ｙλ[fＹY\x0e？πς␆［7Ｋ\r\x10‛␀ξκ␕I／e n",
  ],
  [
    EncodeColon | EncodeLeftSpace | EncodeRightSpace,
    "  ␚ａ＼εsK&＃ｇＭω？T！\x06ς%＇\x1e␅!ｏφ|\nυ \b",
    "␠ ␚ａ＼εsK&＃ｇＭω？T！\x06ς%＇\x1e␅!ｏφ|\nυ \b",
  ],
  [
    EncodeQuestion | EncodeLeftSpace | EncodeRightSpace,
    "  \x19+ｇ%\x16*ZM３␝，␍\n␞δ~f\x19［δκＶ｜ｙγＴ χ",
    "␠ \x19+ｇ%\x16*ZM３␝，␍\n␞δ~f\x19［δκＶ｜ｙγＴ χ",
  ],
  [
    EncodeAsterisk | EncodeLeftSpace | EncodeRightSpace,
    "  α；!\x1eφ\f＂２␌\x12/εｕ＇x９］aζ␔σ<␔ｖ｀u $",
    "␠ α；!\x1eφ\f＂２␌\x12/εｕ＇x９］aζ␔σ<␔ｖ｀u $",
  ],
  [
    EncodePipe | EncodeLeftSpace | EncodeRightSpace,
    '  ␉;χ}ｗOσ＇KJＳ＜＊"F\x15\x18\x14ηθ␑␕：ρ４O \\',
    '␠ ␉;χ}ｗOσ＇KJＳ＜＊"F\x15\x18\x14ηθ␑␕：ρ４O \\',
  ],
  [
    EncodeHash | EncodeLeftSpace | EncodeRightSpace,
    "  ｆ＿␟κυ｜/z3Ｕπ:␕␎\x10／｀\x03rψ?%uｆ\nＨ ␇",
    "␠ ｆ＿␟κυ｜/z3Ｕπ:␕␎\x10／｀\x03rψ?%uｆ\nＨ ␇",
  ],
  [
    EncodePercent | EncodeLeftSpace | EncodeRightSpace,
    "  π\x04ρ\x02\x10ｏ\x0e？ｊ`cφ␒Ｋς␂％βZN'ι␔＂\x10ｖ ！",
    "␠ π\x04ρ\x02\x10ｏ\x0e？ｊ`cφ␒Ｋς␂‛％βZN'ι␔＂\x10ｖ ！",
  ],
  [
    EncodeBackSlash | EncodeLeftSpace | EncodeRightSpace,
    "  ν0\x10ｕ:β＂ε？５␞～\nw＝␏\"％α|Q＂'φ␈\x06 Ｒ",
    "␠ ν0\x10ｕ:β＂ε？５␞～\nw＝␏\"％α|Q＂'φ␈\x06 Ｒ",
  ],
  [
    EncodeCrLf | EncodeLeftSpace | EncodeRightSpace,
    "  φιH\x17＃ι\x18\x19ς␎λA\\Ｉ\x11/Ｉ\bＥG＊?６-␕ｂ ␅",
    "␠ φιH\x17＃ι\x18\x19ς␎λA\\Ｉ\x11/Ｉ\bＥG＊?６-␕ｂ ␅",
  ],
  [
    EncodeDel | EncodeLeftSpace | EncodeRightSpace,
    "  ｙ％␇␂<%Ｎ／％Ｉｘ＼/ξτ\x03O;\x0f\x1aιu␟1ω% δ",
    "␠ ｙ％␇␂<%Ｎ／％Ｉｘ＼/ξτ\x03O;\x0f\x1aιu␟1ω% δ",
  ],
  [
    EncodeCtl | EncodeLeftSpace | EncodeRightSpace,
    "  \x03\rς－eφLMb␄␅␈Ｊ｀＠φο4\x15\x12␖ｕ／\x10;␟ ／",
    "␠ ␃␍ς－eφLMb‛␄‛␅‛␈Ｊ｀＠φο4␕␒‛␖ｕ／␐;‛␟ ／",
  ],
  [
    EncodeZero | EncodeLeftSpace | EncodeRightPeriod,
    " .χ␕␜'}7Ｊ␞γωYB>｀κ＋\b＊σ\x01\x1e０\r＇;／.D",
    "␠.χ␕␜'}7Ｊ␞γωYB>｀κ＋\b＊σ\x01\x1e０\r＇;／.D",
  ],
  [
    EncodeSlash | EncodeLeftSpace | EncodeRightPeriod,
    " ._␇\f\x14(\x17π\vψｖＨｌυ／δＵ?bcb７␋％ω?`.␋",
    "␠._␇\f\x14(\x17π\vψｖＨｌυ‛／δＵ?bcb７␋％ω?`.␋",
  ],
  [
    EncodeSingleQuote | EncodeLeftSpace | EncodeRightPeriod,
    " .＼\x13＆γＦε\x10ｗ␟χ\b␍γξ／^{D3␛9ψ＼ｂA\x1e.\x03",
    "␠.＼\x13＆γＦε\x10ｗ␟χ\b␍γξ／^{D3␛9ψ＼ｂA\x1e.\x03",
  ],
  [
    EncodeBackQuote | EncodeLeftSpace | EncodeRightPeriod,
    " .μ␈i＠］\x13␓－␊\t／8ｋφς９3κｓ\x17J1\x16υ\n␕.＾",
    "␠.μ␈i＠］\x13␓－␊\t／8ｋφς９3κｓ\x17J1\x16υ\n␕.＾",
  ],
  [
    EncodeLtGt | EncodeLeftSpace | EncodeRightPeriod,
    " .＊λｓｓ\x05＜*_␊?＂\x17\x02`\x15｀ξεβＡζ␓Ｓ@\n］.S",
    "␠.＊λｓｓ\x05‛＜*_␊?＂\x17\x02`\x15｀ξεβＡζ␓Ｓ@\n］.S",
  ],
  [
    EncodeSquareBracket | EncodeLeftSpace | EncodeRightPeriod,
    " .␅␆ｋσｂ`\n[␞qｑ\f7｀␀␔/,]νκ|Ｔ\x15<ψ.χ",
    "␠.␅␆ｋσｂ`\n［␞qｑ\f7｀‛␀␔/,］νκ|Ｔ\x15<ψ.χ",
  ],
  [
    EncodeSemicolon | EncodeLeftSpace | EncodeRightPeriod,
    " .ｓ␃\x1f␗;＠y@\x02LφςRπ\x7fαB␒ν␞␃\x11Ｊ\x18␚！.w",
    "␠.ｓ␃\x1f␗；＠y@\x02LφςRπ\x7fαB␒ν␞␃\x11Ｊ\x18␚！.w",
  ],
  [
    EncodeExclamation | EncodeLeftSpace | EncodeRightPeriod,
    " .ＡF(␂␒ηV?ｖvμ＃ω\x10τ\x00?␊\x07！１\x7fρ/\uff00␈.［",
    "␠.ＡF(␂␒ηV?ｖvμ＃ω\x10τ␀?␊\x07‛！１\x7fρ/\uff00␈.［",
  ],
  [
    EncodeDollar | EncodeLeftSpace | EncodeRightPeriod,
    ' .␑ο#１ψ␟υｏ\bG/"ｏ／"μ｜οＢ;␘\x0eNι｀％.b',
    '␠.␑ο#１ψ␟υｏ\bG/"ｏ／"μ｜οＢ;␘\x0eNι｀％.b',
  ],
  [
    EncodeDoubleQuote | EncodeLeftSpace | EncodeRightPeriod,
    " .＄＆ψ'＃，j：？ω［kπ␎M%␝\x1fh\x16γ␖\x00R\x15{.ｇ",
    "␠.＄＆ψ'＃，j：？ω［kπ␎M%␝\x1fh\x16γ␖␀R\x15{.ｇ",
  ],
  [
    EncodeColon | EncodeLeftSpace | EncodeRightPeriod,
    " .ιυz␆\x19AＣ／\n!\x7f\x11A％γＤ（␓␂Vπδ␍\x0e｜ｃ.ｇ",
    "␠.ιυz␆\x19AＣ／\n!\x7f\x11A％γＤ（␓␂Vπδ␍\x0e｜ｃ.ｇ",
  ],
  [
    EncodeQuestion | EncodeLeftSpace | EncodeRightPeriod,
    " .␗`ｒ␛xｕMθ␇\x01$\\On\x03␁φδ６␙␡８＃=χ\x05.υ",
    "␠.␗`ｒ␛xｕMθ␇\x01$\\On\x03␁φδ６␙␡８＃=χ\x05.υ",
  ],
  [
    EncodeAsterisk | EncodeLeftSpace | EncodeRightPeriod,
    " .o␊0－␙＋ｅσk＇ψｔψｆ\x1aλζ\x10␇\x00␕\b␎［X..ν",
    "␠.o␊0－␙＋ｅσk＇ψｔψｆ\x1aλζ\x10␇␀␕\b␎［X..ν",
  ],
  [
    EncodePipe | EncodeLeftSpace | EncodeRightPeriod,
    " .πξｃＧ#\x1b＃ｂιxaＰδθ\b␔␄\rR７＄<！pＡ␍.μ",
    "␠.πξｃＧ#\x1b＃ｂιxaＰδθ\b␔␄\rR７＄<！pＡ␍.μ",
  ],
  [
    EncodeHash | EncodeLeftSpace | EncodeRightPeriod,
    " .${␗δγｅ]\x1b}Ｒθ＼β7␍＞␏～σ\b.ξ␇＇／\x02.\r",
    "␠.${␗δγｅ]\x1b}Ｒθ＼β7␍＞␏～σ\b.ξ␇＇／\x02.\r",
  ],
  [
    EncodePercent | EncodeLeftSpace | EncodeRightPeriod,
    " .␔␀␊η\x1bι＂Ｉ\x7f．␛-7／Z{ｖε\x1a:κεuβ\x03４.\x1b",
    "␠.␔‛␀␊η\x1bι＂Ｉ\x7f．␛-7／Z{ｖε\x1a:κεuβ\x03４.\x1b",
  ],
  [
    EncodeBackSlash | EncodeLeftSpace | EncodeRightPeriod,
    ' .Ｗ␝ν,ＸR\r１S＂\r\x7f␀\x1aqνlＸυ；Jιυ"\x07ｃ.＄',
    '␠.Ｗ␝ν,ＸR\r１S＂\r\x7f‛␀\x1aqνlＸυ；Jιυ"\x07ｃ.＄',
  ],
  [
    EncodeCrLf | EncodeLeftSpace | EncodeRightPeriod,
    " .ρ#ｌ\vβw？␒␘］␏\x1157＋εκ\x1eｏν^／～Z＄\f.;",
    "␠.ρ#ｌ\vβw？␒␘］␏\x1157＋εκ\x1eｏν^／～Z＄\f.;",
  ],
  [
    EncodeDel | EncodeLeftSpace | EncodeRightPeriod,
    " .［4｜｜\rh\n␎\x02ｉαμυ3［αχ␈/δ\b&０p␜␈.e",
    "␠.［4｜｜\rh\n␎\x02ｉαμυ3［αχ␈/δ\b&０p␜␈.e",
  ],
  [
    EncodeCtl | EncodeLeftSpace | EncodeRightPeriod,
    " .Ｄ?ＲＯJE␟␚\x10␍%␝κτ\x19\x02O\x1d␔｝UＨ1υ１α.ξ",
    "␠.Ｄ?ＲＯJE‛␟‛␚␐‛␍%‛␝κτ␙␂O␝‛␔｝UＨ1υ１α.ξ",
  ],
  [
    EncodeZero | EncodeLeftSpace | EncodeRightCrLfHtVt,
    ' \t␊｜＇ω\r＄η{～"δ␙＜`\x1fν！Ｑ1_φ␁9ｂ\x12V\tε',
    '␠\t␊｜＇ω\r＄η{～"δ␙＜`\x1fν！Ｑ1_φ␁9ｂ\x12V\tε',
  ],
  [
    EncodeSlash | EncodeLeftSpace | EncodeRightCrLfHtVt,
    ' \t！u|J[］：Ｋ＝λ４fοηｊ"Ｅ\x1eπ␍tς\x15；ｒ｀\t$',
    '␠\t！u|J[］：Ｋ＝λ４fοηｊ"Ｅ\x1eπ␍tς\x15；ｒ｀\t$',
  ],
  [
    EncodeSingleQuote | EncodeLeftSpace | EncodeRightCrLfHtVt,
    " \t%（+ｈ［ＰD~θζ／πομ％␃*/]\bU\x1e␇ｍ␈／\tD",
    "␠\t%（+ｈ［ＰD~θζ／πομ％␃*/]\bU\x1e␇ｍ␈／\tD",
  ],
  [
    EncodeBackQuote | EncodeLeftSpace | EncodeRightCrLfHtVt,
    ' \tｂς␜α0*:\x07PTＬζ［＊B␍）＂κ３\x07\x00\x18"␔␊\t＆',
    '␠\tｂς␜α0*:\x07PTＬζ［＊B␍）＂κ３\x07␀\x18"␔␊\t＆',
  ],
  [
    EncodeLtGt | EncodeLeftSpace | EncodeRightCrLfHtVt,
    " \t］␖ρ＞\x04～／\x1fｈψ\x02!｀ηIθ；ι2-\x15｀Ｔn$λ\t＂",
    "␠\t］␖ρ‛＞\x04～／\x1fｈψ\x02!｀ηIθ；ι2-\x15｀Ｔn$λ\t＂",
  ],
  [
    EncodeSquareBracket | EncodeLeftSpace | EncodeRightCrLfHtVt,
    " \tｘ␜i８@κｄwπ\x11␅␜αψ\nτ＃\n4Ｆ$］ｙ\x0f?p\t\x02",
    "␠\tｘ␜i８@κｄwπ\x11␅␜αψ\nτ＃\n4Ｆ$‛］ｙ\x0f?p\t\x02",
  ],
  [
    EncodeSemicolon | EncodeLeftSpace | EncodeRightCrLfHtVt,
    ' \t␑α-N\t\x12\r７＠）＂qπι！␕ζ！)␀ｅyα"＞`\tβ',
    '␠\t␑α-N\t\x12\r７＠）＂qπι！␕ζ！)‛␀ｅyα"＞`\tβ',
  ],
  [
    EncodeExclamation | EncodeLeftSpace | EncodeRightCrLfHtVt,
    " \t５␀)$ι＄ψζ3N\x04ｇ｝γQ２`␈ｉ␞\x00␡ςＪ\x00\t\tο",
    "␠\t５‛␀)$ι＄ψζ3N\x04ｇ｝γQ２`␈ｉ␞␀␡ςＪ␀\t\tο",
  ],
  [
    EncodeDollar | EncodeLeftSpace | EncodeRightCrLfHtVt,
    " \t␑ｈθ\x02\x01\\7␡3ιＹδ１\x13Ｒ␒κ\x06\x11＼ξυ␙Ｅ:／\tｍ",
    "␠\t␑ｈθ\x02\x01\\7␡3ιＹδ１\x13Ｒ␒κ\x06\x11＼ξυ␙Ｅ:／\tｍ",
  ],
  [
    EncodeDoubleQuote | EncodeLeftSpace | EncodeRightCrLfHtVt,
    ' \tνｙ{\x13］π\r＂"\x0fδｗμ␈␔\x03；PD␞＠␏L＇ιk\tι',
    "␠\tνｙ{\x13］π\r‛＂＂\x0fδｗμ␈␔\x03；PD␞＠␏L＇ιk\tι",
  ],
  [
    EncodeColon | EncodeLeftSpace | EncodeRightCrLfHtVt,
    ' \t\x1b␉Ａrｄθ\n\x1dγａζ␝:＃ ：τ\x1fCαｒO｜"Ｋ \t␕',
    '␠\t\x1b␉Ａrｄθ\n\x1dγａζ␝：＃ ‛：τ\x1fCαｒO｜"Ｋ \t␕',
  ],
  [
    EncodeQuestion | EncodeLeftSpace | EncodeRightCrLfHtVt,
    " \t［＊α␑υ\n=W\x06σｘ＇\uff00␛\r\b\x1bKλεο␝U[＼＆\t:",
    "␠\t［＊α␑υ\n=W\x06σｘ＇\uff00␛\r\b\x1bKλεο␝U[＼＆\t:",
  ],
  [
    EncodeAsterisk | EncodeLeftSpace | EncodeRightCrLfHtVt,
    " \tζ␀#［\x1a␓θr４:ｓω␍*Zρ－:␛Aｋ␓`\x1aFξ\tＷ",
    "␠\tζ‛␀#［\x1a␓θr４:ｓω␍＊Zρ－:␛Aｋ␓`\x1aFξ\tＷ",
  ],
  [
    EncodePipe | EncodeLeftSpace | EncodeRightCrLfHtVt,
    " \tＲ\x0eγ／＂␗＼W／\x11\x14｝＼η_］\x13\x17ςδ ω␈K[1\tb",
    "␠\tＲ\x0eγ／＂␗＼W／\x11\x14｝＼η_］\x13\x17ςδ ω␈K[1\tb",
  ],
  [
    EncodeHash | EncodeLeftSpace | EncodeRightCrLfHtVt,
    " \t＼C!j\nρ\x18／␒ｗa＞wε=τ！ρ＊\n｜ｓω｀I\x7f\t\x1e",
    "␠\t＼C!j\nρ\x18／␒ｗa＞wε=τ！ρ＊\n｜ｓω｀I\x7f\t\x1e",
  ],
  [
    EncodePercent | EncodeLeftSpace | EncodeRightCrLfHtVt,
    " \t/ＺｓＦξ␐<φ}\\：ｒ\x174ψ[θ|＃ο\f␔ｏ␋σ`\t＃",
    "␠\t/ＺｓＦξ␐<φ}\\：ｒ\x174ψ[θ|＃ο\f␔ｏ␋σ`\t＃",
  ],
  [
    EncodeBackSlash | EncodeLeftSpace | EncodeRightCrLfHtVt,
    " \t＊␟\x1a'θσO\nψＲ／\\␏␞ｅδ␛uθ％／２\x02\x0eＯt\tt",
    "␠\t＊␟\x1a'θσO\nψＲ／＼␏␞ｅδ␛uθ％／２\x02\x0eＯt\tt",
  ],
  [
    EncodeDel | EncodeLeftSpace | EncodeRightCrLfHtVt,
    " \t␈Ｅ；％␋␑\x11φn｜\x02␂ιξＵＵ[T<\x11VλU\x10θ＋\tc",
    "␠\t␈Ｅ；％␋␑\x11φn｜\x02␂ιξＵＵ[T<\x11VλU\x10θ＋\tc",
  ],
  [
    EncodeZero | EncodeLeftPeriod | EncodeLeftTilde,
    ".~\x11bSπ；ε␗ε\x17N]S␙％λ＆＇ｍ＼;:ν\x19e＃σ~／",
    "．~\x11bSπ；ε␗ε\x17N]S␙％λ＆＇ｍ＼;:ν\x19e＃σ~／",
  ],
  [
    EncodeSlash | EncodeLeftPeriod | EncodeLeftTilde,
    ".~Ｍｗ␖␇lχM␗｛\x01s␞ｆρ|ξ␝＜ｖμu\x02\vＸY\x12~α",
    "．~Ｍｗ␖␇lχM␗｛\x01s␞ｆρ|ξ␝＜ｖμu\x02\vＸY\x12~α",
  ],
  [
    EncodeSingleQuote | EncodeLeftPeriod | EncodeLeftTilde,
    ".~[z-π／ξ␎ｇνπ0_t\x00Ｄｃ％>τＫ>\x1d␀o␃η~＠",
    "．~[z-π／ξ␎ｇνπ0_t␀Ｄｃ％>τＫ>\x1d‛␀o␃η~＠",
  ],
  [
    EncodeBackQuote | EncodeLeftPeriod | EncodeLeftTilde,
    ".~\x14ς\x14！α␍Ｗ＊θＵt\x06λ～Y８1␞＋\x07\x1cuｄg␟N~β",
    "．~\x14ς\x14！α␍Ｗ＊θＵt\x06λ～Y８1␞＋\x07\x1cuｄg␟N~β",
  ],
  [
    EncodeLtGt | EncodeLeftPeriod | EncodeLeftTilde,
    ".~\x1eρυ\x05１E\x1fwd␊F␐Ｌξ：＄５uｆ\x1aοω／）δ\x00~\x02",
    "．~\x1eρυ\x05１E\x1fwd␊F␐Ｌξ：＄５uｆ\x1aοω／）δ␀~\x02",
  ],
  [
    EncodeSquareBracket | EncodeLeftPeriod | EncodeLeftTilde,
    ".~ς＞γ<-K＃２πα\x01ο␈nＥ␟\x18>␛｛+ｏ␚]<\x0e~#",
    "．~ς＞γ<-K＃２πα\x01ο␈nＥ␟\x18>␛｛+ｏ␚］<\x0e~#",
  ],
  [
    EncodeSemicolon | EncodeLeftPeriod | EncodeLeftTilde,
    ".~\x17σ␉／θ\tχ８D␜χ|)ｒ␍ｏｓ\x16σDｑ!\x1a\x10μ\x01~␇",
    "．~\x17σ␉／θ\tχ８D␜χ|)ｒ␍ｏｓ\x16σDｑ!\x1a\x10μ\x01~␇",
  ],
  [
    EncodeExclamation | EncodeLeftPeriod | EncodeLeftTilde,
    ".~ε␡ζ␞｛｜ε\x02φ］５\x10␀\f\uff00␄F＋\x07α＞ｓ\x18b]G~+",
    "．~ε␡ζ␞｛｜ε\x02φ］５\x10‛␀\f\uff00␄F＋\x07α＞ｓ\x18b]G~+",
  ],
  [
    EncodeDollar | EncodeLeftPeriod | EncodeLeftTilde,
    '.~～ｗ｜\x06＊Ｎi:＇"!δ］*␀θι\x1dg␞ς9＋πo*~e',
    '．~～ｗ｜\x06＊Ｎi:＇"!δ］*‛␀θι\x1dg␞ς9＋πo*~e',
  ],
  [
    EncodeDoubleQuote | EncodeLeftPeriod | EncodeLeftTilde,
    ".~μ\x19νκ>␂x｝,Ｚ\x1d␝＿␍Oλ，␅＋Dς＄ｇμ␌.~\x01",
    "．~μ\x19νκ>␂x｝,Ｚ\x1d␝＿␍Oλ，␅＋Dς＄ｇμ␌.~\x01",
  ],
  [
    EncodeColon | EncodeLeftPeriod | EncodeLeftTilde,
    ".~＿γi\x1c（τ\b␙\x1fχρ␌\x1aＱκ＿zＣ；?Kiξ'+␂~ｃ",
    "．~＿γi\x1c（τ\b␙\x1fχρ␌\x1aＱκ＿zＣ；?Kiξ'+␂~ｃ",
  ],
  [
    EncodeQuestion | EncodeLeftPeriod | EncodeLeftTilde,
    ".~\x04Ａ>ς␌.\b␏\n␇．ε␘｝ιＭ|\rεu*ｄ7␇\x1c␒~g",
    "．~\x04Ａ>ς␌.\b␏\n␇．ε␘｝ιＭ|\rεu*ｄ7␇\x1c␒~g",
  ],
  [
    EncodeAsterisk | EncodeLeftPeriod | EncodeLeftTilde,
    '.~ρN\x01＂␡5ｋ␘？；"％δγωP<<［␁\nＲ*κ[/~\x00',
    '．~ρN\x01＂␡5ｋ␘？；"％δγωP<<［␁\nＲ＊κ[/~␀',
  ],
  [
    EncodePipe | EncodeLeftPeriod | EncodeLeftTilde,
    ".~/｀\x18Ｅζ␊rγι\x16␓Ａ5\x13ｕ，ｘ9ω＂$␓θ␘κ~~x",
    "．~/｀\x18Ｅζ␊rγι\x16␓Ａ5\x13ｕ，ｘ9ω＂$␓θ␘κ~~x",
  ],
  [
    EncodeHash | EncodeLeftPeriod | EncodeLeftTilde,
    ".~？／␔ｄｏm＠f０␜σ\n\x01␍eοβ[:ζｗψτ␑\r\x02~(",
    "．~？／␔ｄｏm＠f０␜σ\n\x01␍eοβ[:ζｗψτ␑\r\x02~(",
  ],
  [
    EncodePercent | EncodeLeftPeriod | EncodeLeftTilde,
    ".~＜␉ο\x011λ\x1c\x7fι\x1aδ＞；\\［｛m\n｀9ＵX␔＇>γ~f",
    "．~＜␉ο\x011λ\x1c\x7fι\x1aδ＞；\\［｛m\n｀9ＵX␔＇>γ~f",
  ],
  [
    EncodeBackSlash | EncodeLeftPeriod | EncodeLeftTilde,
    ".~␝@␏ｌτ␊\x1a３dω\x12／η>ςｊ\x19／␒：～J；,:ζ~/",
    "．~␝@␏ｌτ␊\x1a３dω\x12／η>ςｊ\x19／␒：～J；,:ζ~/",
  ],
  [
    EncodeCrLf | EncodeLeftPeriod | EncodeLeftTilde,
    ".~*\n｀ν＃\x07␊＊Bｒ\x03q.ωＹ0␌␋θU４>␈\nυ␞~λ",
    "．~*␊｀ν＃\x07‛␊＊Bｒ\x03q.ωＹ0␌␋θU４>␈␊υ␞~λ",
  ],
  [
    EncodeDel | EncodeLeftPeriod | EncodeLeftTilde,
    ".~\x01|σ/α␙＄>S␂r␔\x11ｖ\x10ａzＬφ4η（η␃␌{~Ｈ",
    "．~\x01|σ/α␙＄>S␂r␔\x11ｖ\x10ａzＬφ4η（η␃␌{~Ｈ",
  ],
  [
    EncodeCtl | EncodeLeftPeriod | EncodeLeftTilde,
    ".~\\'χ5␕χ＜zψ\x18ＫH\x1c\x15\tＣ␍｀␜χ%κ／\x1eＬ␛~＂",
    "．~\\'χ5‛␕χ＜zψ␘ＫH␜␕␉Ｃ‛␍｀‛␜χ%κ／␞Ｌ‛␛~＂",
  ],
  [
    EncodeZero | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\t\r'σＯT｀\x1a['\x7f＂{dz．ν＜φ７\x11ψδ␌␘８｜\tε",
    "．\t\r'σＯT｀\x1a['\x7f＂{dz．ν＜φ７\x11ψδ␌␘８｜\tε",
  ],
  [
    EncodeSlash | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    '.\tＥ\n␂τE\x18ωVＹησ␁␟ｎ␇␙`＿ρ．Ｐn"υ\x19<\tO',
    '．\tＥ\n␂τE\x18ωVＹησ␁␟ｎ␇␙`＿ρ．Ｐn"υ\x19<\tO',
  ],
  [
    EncodeSingleQuote | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\t＆/+\r}τμ␌ｐ_ｚxχοL\x12＋D!␀␁Ｔα！␖＂\t\x1b",
    "．\t＆/+\r}τμ␌ｐ_ｚxχοL\x12＋D!‛␀␁Ｔα！␖＂\t\x1b",
  ],
  [
    EncodeBackQuote | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\t␌\rｙ␄␜>\nη[>τε｛\v\\(iｏ\x1c－Ｌ４υγ␒!\t␇",
    "．\t␌\rｙ␄␜>\nη[>τε｛\v\\(iｏ\x1c－Ｌ４υγ␒!\t␇",
  ],
  [
    EncodeLtGt | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\tδY\x0fψ＼P\x06Ｗ␘w␞E\tｌδ\x03|␒␘␍ｒδ５C\x05σ\t␏",
    "．\tδY\x0fψ＼P\x06Ｗ␘w␞E\tｌδ\x03|␒␘␍ｒδ５C\x05σ\t␏",
  ],
  [
    EncodeSquareBracket | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\t\r=］*Ｅτ｀Jρ\x12 ／\x13｛ｎ:␎&\x11␇φ９＞Hψι\t\x17",
    "．\t\r=‛］*Ｅτ｀Jρ\x12 ／\x13｛ｎ:␎&\x11␇φ９＞Hψι\t\x17",
  ],
  [
    EncodeSemicolon | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\tＦ|\x1co'\x15γξ.δｚ!ςθ/ＹＵ␐\x101％υ␝␒␂[\t５",
    "．\tＦ|\x1co'\x15γξ.δｚ!ςθ/ＹＵ␐\x101％υ␝␒␂[\t５",
  ],
  [
    EncodeExclamation | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\tizξ＋'．/＇ｌκ\x07＃（？\uff00\x19υ｜1ο<γ␗6\x15␍\tτ",
    "．\tizξ＋'．/＇ｌκ\x07＃（？\uff00\x19υ｜1ο<γ␗6\x15␍\tτ",
  ],
  [
    EncodeDollar | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\t\x01t６/ｋχ２τG␛␕\nσI］Dκθ*Ｎ␅ｈ<［\x0e_\t␟",
    "．\t\x01t６/ｋχ２τG␛␕\nσI］Dκθ*Ｎ␅ｈ<［\x0e_\t␟",
  ],
  [
    EncodeDoubleQuote | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\tοφ␕2\b/Ｆ\x1f，\\␏1}τY\x17ι＾Ｏ\x13Ｈ\nｑ／ι␅\t␐",
    "．\tοφ␕2\b/Ｆ\x1f，\\␏1}τY\x17ι＾Ｏ\x13Ｈ\nｑ／ι␅\t␐",
  ],
  [
    EncodeColon | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\tσw:Ｄ(O$］ω\bχδI？\x1c␊\nζＰ␏␊＋␒ｏ\x01）\tM",
    "．\tσw：Ｄ(O$］ω\bχδI？\x1c␊\nζＰ␏␊＋␒ｏ\x01）\tM",
  ],
  [
    EncodeQuestion | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\tκψ␂χκ\x15７RυU*Ｊ␐V␁\x10\fＹｙ３＄_␘Dα␀\tａ",
    "．\tκψ␂χκ\x15７RυU*Ｊ␐V␁\x10\fＹｙ３＄_␘Dα‛␀\tａ",
  ],
  [
    EncodeAsterisk | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    '.\tκ␎ωｅ[!i␃\t２λχθ␆χ\n^＞\\ｍＨQ\x0f\\ｘ"\t／',
    '．\tκ␎ωｅ[!i␃\t２λχθ␆χ\n^＞\\ｍＨQ\x0f\\ｘ"\t／',
  ],
  [
    EncodePipe | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\tG8Ｘ6ψκM#%\x10χ＊␍γ\x1f\x02␒８]／U）γ＜：＂\tψ",
    "．\tG8Ｘ6ψκM#%\x10χ＊␍γ\x1f\x02␒８]／U）γ＜：＂\tψ",
  ],
  [
    EncodeHash | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\t＂\x11]RWξＰ\n\x1dι3９＠＂θ}Ａ␍␍␇␉πδ\x07:＞\t#",
    "．\t＂\x11]RWξＰ\n\x1dι3９＠＂θ}Ａ␍␍␇␉πδ\x07:＞\t＃",
  ],
  [
    EncodePercent | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\tι␀ｋ␉τ\x16ｓ％９Ｑh*iγψＨ\x11>>*␡␂>␅οv\t2",
    "．\tι‛␀ｋ␉τ\x16ｓ‛％９Ｑh*iγψＨ\x11>>*␡␂>␅οv\t2",
  ],
  [
    EncodeBackSlash | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    '.\tχ｀*Ｅ4Mｉ\rｉ:?φ\x15？ζ／Ｖ␃\uff00}＃">9ο␌\tρ',
    '．\tχ｀*Ｅ4Mｉ\rｉ:?φ\x15？ζ／Ｖ␃\uff00}＃">9ο␌\tρ',
  ],
  [
    EncodeDel | EncodeLeftPeriod | EncodeLeftCrLfHtVt,
    ".\tκ␎５δq｀＜\x18Ｋ\x02σσ｀１b／μ＇␊7C?\x10$Ｐｆ\tD",
    "．\tκ␎５δq｀＜\x18Ｋ\x02σσ｀１b／μ＇␊7C?\x10$Ｐｆ\tD",
  ],
  [
    EncodeZero | EncodeLeftPeriod | EncodeRightSpace,
    ". |＜＋\x00％ｉ？KS^κ;$Ｎαυυ｛<\v％ｊ＊κ\x12P \x14",
    "． |＜＋␀％ｉ？KS^κ;$Ｎαυυ｛<\v％ｊ＊κ\x12P \x14",
  ],
  [
    EncodeSlash | EncodeLeftPeriod | EncodeRightSpace,
    ". γsｌ＜L]␗ξ8␈(\\ｃ＞ο;ω␅\x16\x1a＄｝ｊ\nβ+ ι",
    "． γsｌ＜L]␗ξ8␈(\\ｃ＞ο;ω␅\x16\x1a＄｝ｊ\nβ+ ι",
  ],
  [
    EncodeSingleQuote | EncodeLeftPeriod | EncodeRightSpace,
    ". θ|ｑＺκＩ％\x7f[␙;υω$␑GX＂\x1dς＋1０}\x18＼ δ",
    "． θ|ｑＺκＩ％\x7f[␙;υω$␑GX＂\x1dς＋1０}\x18＼ δ",
  ],
  [
    EncodeBackQuote | EncodeLeftPeriod | EncodeRightSpace,
    '. pｓ\x01＃\x13Ｈ␔N\tＪｊω␂ρ␚␁ρθ␍Ｏqκ[υ"\n ＇',
    '． pｓ\x01＃\x13Ｈ␔N\tＪｊω␂ρ␚␁ρθ␍Ｏqκ[υ"\n ＇',
  ],
  [
    EncodeLtGt | EncodeLeftPeriod | EncodeRightSpace,
    ". Ｃ*τ%#\x1d\x17！dD␉τ|／␗＇ψsＦＦνH8ς｀\r ／",
    "． Ｃ*τ%#\x1d\x17！dD␉τ|／␗＇ψsＦＦνH8ς｀\r ／",
  ],
  [
    EncodeSquareBracket | EncodeLeftPeriod | EncodeRightSpace,
    '. ␎\x12Z-／δ+C\x00"＿;μιξ＃ς［Ｒ\x1eC\x03＾␁｜β Ａ',
    '． ␎\x12Z-／δ+C␀"＿;μιξ＃ς‛［Ｒ\x1eC\x03＾␁｜β Ａ',
  ],
  [
    EncodeSemicolon | EncodeLeftPeriod | EncodeRightSpace,
    ". ␕::␟＃Ｊ!π+υ＞\x00τ［Ｃ\x18ξ\f（\x1b8Ｊς＇␐＼ R",
    "． ␕::␟＃Ｊ!π+υ＞␀τ［Ｃ\x18ξ\f（\x1b8Ｊς＇␐＼ R",
  ],
  [
    EncodeExclamation | EncodeLeftPeriod | EncodeRightSpace,
    ". ρ\n＞ξN@φWａ␂jζ＜ａ|Iｕ\b\x11ι␐ｚζｇ＇\x01 .",
    "． ρ\n＞ξN@φWａ␂jζ＜ａ|Iｕ\b\x11ι␐ｚζｇ＇\x01 .",
  ],
  [
    EncodeDollar | EncodeLeftPeriod | EncodeRightSpace,
    ". j\x04ｈ'Ｗ］'ＱχＡ｀5χζψQO\x06！ρ␘ψ\x07␓1| '",
    "． j\x04ｈ'Ｗ］'ＱχＡ｀5χζψQO\x06！ρ␘ψ\x07␓1| '",
  ],
  [
    EncodeDoubleQuote | EncodeLeftPeriod | EncodeRightSpace,
    ". ε␞\x02τＩ：／\x17＄ＡＶ␆OriS7\x00ζ＊βεφ␁＞\x13 [",
    "． ε␞\x02τＩ：／\x17＄ＡＶ␆OriS7␀ζ＊βεφ␁＞\x13 [",
  ],
  [
    EncodeColon | EncodeLeftPeriod | EncodeRightSpace,
    ". \x15ζｚU,λ\x13＇γ>κ7\\\x16␊／ｌφPζｄM；␋␚\x11 Ｊ",
    "． \x15ζｚU,λ\x13＇γ>κ7\\\x16␊／ｌφPζｄM；␋␚\x11 Ｊ",
  ],
  [
    EncodeQuestion | EncodeLeftPeriod | EncodeRightSpace,
    ". cμｒU\x7f`Aβ␓␇@ξ(ψ９，␆␉εｘ０␂m\x1d␂! ε",
    "． cμｒU\x7f`Aβ␓␇@ξ(ψ９，␆␉εｘ０␂m\x1d␂! ε",
  ],
  [
    EncodeAsterisk | EncodeLeftPeriod | EncodeRightSpace,
    '. oχBνX！μφ#Ｓ＼Ｖ[_"␚␇\x13\x11>␓␙｝ｂｆυ \x1b',
    '． oχBνX！μφ#Ｓ＼Ｖ[_"␚␇\x13\x11>␓␙｝ｂｆυ \x1b',
  ],
  [
    EncodePipe | EncodeLeftPeriod | EncodeRightSpace,
    '. \x1b\x0e\f1－＜kｓχ［\x02"␒Ｘ＆θU␍␟π@\x0f%ε␊υ ␉',
    '． \x1b\x0e\f1－＜kｓχ［\x02"␒Ｘ＆θU␍␟π@\x0f%ε␊υ ␉',
  ],
  [
    EncodeHash | EncodeLeftPeriod | EncodeRightSpace,
    ". \x1b；λｍ%'κ;␟ｐ\x16δυＣavk␌\x1d！J␄υχ＠\x17 ?",
    "． \x1b；λｍ%'κ;␟ｐ\x16δυＣavk␌\x1d！J␄υχ＠\x17 ?",
  ],
  [
    EncodePercent | EncodeLeftPeriod | EncodeRightSpace,
    ". $υοＵＫｚ１σ＞␙␐␆/e␊2＜＼ςaμ!|８\\\x1f c",
    "． $υοＵＫｚ１σ＞␙␐␆/e␊2＜＼ςaμ!|８\\\x1f c",
  ],
  [
    EncodeBackSlash | EncodeLeftPeriod | EncodeRightSpace,
    '. j\x0e␛]\t␇U:５␊＂␁\x15υψ；"\v＠Jςε␛ξ；R {',
    '． j\x0e␛]\t␇U:５␊＂␁\x15υψ；"\v＠Jςε␛ξ；R {',
  ],
  [
    EncodeCrLf | EncodeLeftPeriod | EncodeRightSpace,
    '. ＼"\n␒κ\x18gουυ％ο｜W(:?NＹ４\x0f␊c␋／β Ｄ',
    '． ＼"␊␒κ\x18gουυ％ο｜W(:?NＹ４\x0f‛␊c␋／β Ｄ',
  ],
  [
    EncodeDel | EncodeLeftPeriod | EncodeRightSpace,
    ". Ｓ␂］ω｜lｆγ#␘／[６\\|sj<\x13；ωεＯ\x01oς Ｃ",
    "． Ｓ␂］ω｜lｆγ#␘／[６\\|sj<\x13；ωεＯ\x01oς Ｃ",
  ],
  [
    EncodeCtl | EncodeLeftPeriod | EncodeRightSpace,
    '. ％｛ｙ"KfＯ␘κ␀:\rρ：\x19\x18ｌζ␟ｒλz0＜\x13κ ρ',
    '． ％｛ｙ"KfＯ‛␘κ‛␀:␍ρ：␙␘ｌζ‛␟ｒλz0＜␓κ ρ',
  ],
  [
    EncodeZero | EncodeLeftPeriod | EncodeRightPeriod,
    "..σｂz，!'␆8＂␅，%νη\x1a＃］\x06␅w＂πLＷωα.,",
    "．.σｂz，!'␆8＂␅，%νη\x1a＃］\x06␅w＂πLＷωα.,",
  ],
  [
    EncodeSlash | EncodeLeftPeriod | EncodeRightPeriod,
    "..ψλ\x1cＬ,\x7f\x05＿χW\x04K␔ＤλmNd！ν１γ６␑\x1f].Ｃ",
    "．.ψλ\x1cＬ,\x7f\x05＿χW\x04K␔ＤλmNd！ν１γ６␑\x1f].Ｃ",
  ],
  [
    EncodeSingleQuote | EncodeLeftPeriod | EncodeRightPeriod,
    "..\vｗ\x15％␌␛ν．＼φ＠Bρ!Nη\\！|]␔ζmζ\x07＠.\x1a",
    "．.\vｗ\x15％␌␛ν．＼φ＠Bρ!Nη\\！|]␔ζmζ\x07＠.\x1a",
  ],
  [
    EncodeBackQuote | EncodeLeftPeriod | EncodeRightPeriod,
    "..␐＿\x0f␄[｝+C＃fｉ\x16ｕα（η␈＂Ｇ\\φαSCς␇.A",
    "．.␐＿\x0f␄[｝+C＃fｉ\x16ｕα（η␈＂Ｇ\\φαSCς␇.A",
  ],
  [
    EncodeLtGt | EncodeLeftPeriod | EncodeRightPeriod,
    "..ωωο０^＊＃\x00β#\\B／␂αξ3]＆\x05７(F␆␕\x01.ｇ",
    "．.ωωο０^＊＃␀β#\\B／␂αξ3]＆\x05７(F␆␕\x01.ｇ",
  ],
  [
    EncodeSquareBracket | EncodeLeftPeriod | EncodeRightPeriod,
    "..ｙｅＰ\x16q4A\r#␔ψ␊␆：9\x1bηα␜Ｙτｔσ␙υV.#",
    "．.ｙｅＰ\x16q4A\r#␔ψ␊␆：9\x1bηα␜Ｙτｔσ␙υV.#",
  ],
  [
    EncodeSemicolon | EncodeLeftPeriod | EncodeRightPeriod,
    "..\r＃ω\x14ζλυ\x18：ςτJg␉：/ａX\x10＂␄/'g＊ｏ.Ｃ",
    "．.\r＃ω\x14ζλυ\x18：ςτJg␉：/ａX\x10＂␄/'g＊ｏ.Ｃ",
  ],
  [
    EncodeExclamation | EncodeLeftPeriod | EncodeRightPeriod,
    "..ψ\f␉η*␆␖␁λυ/\x11｀；γP;\vｈ％&＞\x14␔ｚ\x00.*",
    "．.ψ\f␉η*␆␖␁λυ/\x11｀；γP;\vｈ％&＞\x14␔ｚ␀.*",
  ],
  [
    EncodeDollar | EncodeLeftPeriod | EncodeRightPeriod,
    "..␁\x0faα\x1eb␆␆|\x06φδＫ＾&:＊κ＼␇ｌ␚␕@Ｕς.k",
    "．.␁\x0faα\x1eb␆␆|\x06φδＫ＾&:＊κ＼␇ｌ␚␕@Ｕς.k",
  ],
  [
    EncodeDoubleQuote | EncodeLeftPeriod | EncodeRightPeriod,
    '..？\f\x1aQ␙<ω］␍πτ";/"３]μｐ#ｐ［␙\x1eνｏ.x',
    "．.？\f\x1aQ␙<ω］␍πτ＂;/＂３]μｐ#ｐ［␙\x1eνｏ.x",
  ],
  [
    EncodeColon | EncodeLeftPeriod | EncodeRightPeriod,
    "..e＼\n␖\nχWχ␆sＦη；\x0eＤ\nζ-ι？６8γ␋５S.]",
    "．.e＼\n␖\nχWχ␆sＦη；\x0eＤ\nζ-ι？６8γ␋５S.]",
  ],
  [
    EncodeQuestion | EncodeLeftPeriod | EncodeRightPeriod,
    '..Ｌ！"＠？／!＜gπ］π`＜σ？６oθX9|e␑\x05\x1b.\x1a',
    '．.Ｌ！"＠‛？／!＜gπ］π`＜σ‛？６oθX9|e␑\x05\x1b.\x1a',
  ],
  [
    EncodeAsterisk | EncodeLeftPeriod | EncodeRightPeriod,
    "..>\x17␌ψπPｖλ\x13＜␂，τ\x1bB？Jｓα)␛χｎ|␞\x07.＞",
    "．.>\x17␌ψπPｖλ\x13＜␂，τ\x1bB？Jｓα)␛χｎ|␞\x07.＞",
  ],
  [
    EncodePipe | EncodeLeftPeriod | EncodeRightPeriod,
    "..θ␗␂ｉ\x03>＃\x18ξ␞\x1aｖ\x01␞！θα\\－ｕｙψ:V\x1f｀.;",
    "．.θ␗␂ｉ\x03>＃\x18ξ␞\x1aｖ\x01␞！θα\\－ｕｙψ:V\x1f｀.;",
  ],
  [
    EncodeHash | EncodeLeftPeriod | EncodeRightPeriod,
    "..\v=γ＄␏␘｛）δｚξ２Q\x19\rπ␊υ＄＄η'rV␂A.$",
    "．.\v=γ＄␏␘｛）δｚξ２Q\x19\rπ␊υ＄＄η'rV␂A.$",
  ],
  [
    EncodePercent | EncodeLeftPeriod | EncodeRightPeriod,
    "..`'*␟｝\vτμ\r␄%ρ\rζ\x1e␗β4\x130␊\uff00ｙ\uff00␕␃.ο",
    "．.`'*␟｝\vτμ\r␄％ρ\rζ\x1e␗β4\x130␊\uff00ｙ\uff00␕␃.ο",
  ],
  [
    EncodeBackSlash | EncodeLeftPeriod | EncodeRightPeriod,
    "..␛\x1b：'/／，δυ：γ␎␘\x18ｓφ\"λ:S^␃\biｅＭ.＞",
    "．.␛\x1b：'/／，δυ：γ␎␘\x18ｓφ\"λ:S^␃\biｅＭ.＞",
  ],
  [
    EncodeCrLf | EncodeLeftPeriod | EncodeRightPeriod,
    "..ηψ\x02ｃzλ␝ν␔＂B]５π␡οｅ'{␎0ｅz？\t'.D",
    "．.ηψ\x02ｃzλ␝ν␔＂B]５π␡οｅ'{␎0ｅz？\t'.D",
  ],
  [
    EncodeDel | EncodeLeftPeriod | EncodeRightPeriod,
    '..＿ι\n␉P␀ σωｌ[KＪ%％τσ＇\x13\x1c␂：\x00"V，.＜',
    '．.＿ι\n␉P‛␀ σωｌ[KＪ%％τσ＇\x13\x1c␂：␀"V，.＜',
  ],
  [
    EncodeCtl | EncodeLeftPeriod | EncodeRightPeriod,
    "..＞␄;=\x7fφ␘Ｏμ\x7fkγ$lκＶ|\x0f␐ｎκe\bHρ␘.␘",
    "．.＞‛␄;=\x7fφ‛␘Ｏμ\x7fkγ$lκＶ|␏‛␐ｎκe␈Hρ‛␘.‛␘",
  ],
  [
    EncodeZero | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\t\x1b␍\uff00Ｄκｌ␒\x1a\x0fκω$ｑ/χ．［α\x05？<ρ|\\-：\t｜",
    "．\t\x1b␍\uff00Ｄκｌ␒\x1a\x0fκω$ｑ/χ．［α\x05？<ρ|\\-：\t｜",
  ],
  [
    EncodeSlash | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\tＡｗｏ\x15\v'ξωμ$>χ[␜ｅT\\δ␋␟\x01␕ｄφ\x12,\t␔",
    "．\tＡｗｏ\x15\v'ξωμ$>χ[␜ｅT\\δ␋␟\x01␕ｄφ\x12,\t␔",
  ],
  [
    EncodeSingleQuote | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    '.\t\fη!Ｕπ？Ｋ!＝\r␏E␡ｂθ␐θ␕␔０ｒκ"{t^\tγ',
    '．\t\fη!Ｕπ？Ｋ!＝\r␏E␡ｂθ␐θ␕␔０ｒκ"{t^\tγ',
  ],
  [
    EncodeBackQuote | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\tσμ<[␆δ␡Ａ９\t\tζ␕C＄５` Ｒ␗\x00ψT␝[r\t＿",
    "．\tσμ<[␆δ␡Ａ９\t\tζ␕C＄５｀ Ｒ␗␀ψT␝[r\t＿",
  ],
  [
    EncodeLtGt | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\t\x02\x10τQ\\4\x1d␊iＢ＾mς␎＄P！εζ/Ｊ＜［␅ξγ\t␐",
    "．\t\x02\x10τQ\\4\x1d␊iＢ＾mς␎＄P！εζ/Ｊ‛＜［␅ξγ\t␐",
  ],
  [
    EncodeSquareBracket | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\t＼}>ηｕ\\3（Ｅ\x1bυ␒z［␖κσ\x11φ7␇？␉mε\r\t>",
    "．\t＼}>ηｕ\\3（Ｅ\x1bυ␒z‛［␖κσ\x11φ7␇？␉mε\r\t>",
  ],
  [
    EncodeSemicolon | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\t；␡o>η(o␔χ␐8Ａς[６７␙`αＫ␕ι#?γ\r\t\x02",
    "．\t‛；␡o>η(o␔χ␐8Ａς[６７␙`αＫ␕ι#?γ\r\t\x02",
  ],
  [
    EncodeExclamation | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\t#ｗR␇：δ\x12ｅ）i／!7κt␏\x1d\rχβ＃／δ\v␡β\tＳ",
    "．\t#ｗR␇：δ\x12ｅ）i／！7κt␏\x1d\rχβ＃／δ\v␡β\tＳ",
  ],
  [
    EncodeDollar | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\t\x05δ／d0␆\x0eπ\t｝␐βυ８ｕ\x7f５2＼\bu?Ｆζ／／\tψ",
    "．\t\x05δ／d0␆\x0eπ\t｝␐βυ８ｕ\x7f５2＼\bu?Ｆζ／／\tψ",
  ],
  [
    EncodeDoubleQuote | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\td：ｄκNｓιｌ␜␌Ｉ\x07＾'␜␈bμτφJ?␁#.＇\t*",
    "．\td：ｄκNｓιｌ␜␌Ｉ\x07＾'␜␈bμτφJ?␁#.＇\t*",
  ],
  [
    EncodeColon | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\t｜`ＨＫ＄'／-％φ/ρ␄λφ\x1a４`δ\x01H\nｗκx\x10\t?",
    "．\t｜`ＨＫ＄'／-％φ/ρ␄λφ\x1a４`δ\x01H\nｗκx\x10\t?",
  ],
  [
    EncodeQuestion | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\tιο\x10ρ＃＼4>␟\x01!\x04j４ＺｐD\x0f~｜μ＊␁?ζ？\t＄",
    "．\tιο\x10ρ＃＼4>␟\x01!\x04j４ＺｐD\x0f~｜μ＊␁？ζ‛？\t＄",
  ],
  [
    EncodeAsterisk | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\t␕）Ｅ\x1ax＊\x1fκα␡␇!λι／=θ！\x01d\\\\Ｉ␅６j\tρ",
    "．\t␕）Ｅ\x1ax‛＊\x1fκα␡␇!λι／=θ！\x01d\\\\Ｉ␅６j\tρ",
  ],
  [
    EncodePipe | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\tγ␟κε*ζ\x15＼\x12uψ＇␆Ｕ0␉nＣ␆＼]αＯ<HＭ\t\x16",
    "．\tγ␟κε*ζ\x15＼\x12uψ＇␆Ｕ0␉nＣ␆＼]αＯ<HＭ\t\x16",
  ],
  [
    EncodeHash | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\t＿｀οC\x12ηβα/α␂␏φＶｌ2*␝\x0f␅r0Ｃ␈\x0f\r\t!",
    "．\t＿｀οC\x12ηβα/α␂␏φＶｌ2*␝\x0f␅r0Ｃ␈\x0f\r\t!",
  ],
  [
    EncodePercent | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\tμ\x1cＱ␛f<␜Ｖ\t\x04｜｀θ\x1d\uff00ｐr\x1fＡλ(o%μE␟\t｀",
    "．\tμ\x1cＱ␛f<␜Ｖ\t\x04｜｀θ\x1d\uff00ｐr\x1fＡλ(o％μE␟\t｀",
  ],
  [
    EncodeBackSlash | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\t\nψ｜Ｇ`_ｓ\"Ｉ␗κ/κＶν\x14'＄δ？\x04ξＷ'ｌ\x1b\t％",
    "．\t\nψ｜Ｇ`_ｓ\"Ｉ␗κ/κＶν\x14'＄δ？\x04ξＷ'ｌ\x1b\t％",
  ],
  [
    EncodeDel | EncodeLeftPeriod | EncodeRightCrLfHtVt,
    ".\t␚␒?␁␋>＼\x10ο\x05(＜～ςCYx＄φχO\x1c＝η;，\tκ",
    "．\t␚␒?␁␋>＼\x10ο\x05(＜～ςCYx＄φχO\x1c＝η;，\tκ",
  ],
  [
    EncodeZero | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\tυXμ０/Ｐ/v␃$\x7fμ\x0e\x0eα／．％8Ｍ％4！＄LT\tＫ",
    "～\tυXμ０/Ｐ/v␃$\x7fμ\x0e\x0eα／．％8Ｍ％4！＄LT\tＫ",
  ],
  [
    EncodeSlash | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\tχ｀␓Tｖ^[␞～ωλｈ2j-μ␎␡＇\f＆？\x10:y＊\tι",
    "～\tχ｀␓Tｖ^[␞～ωλｈ2j-μ␎␡＇\f＆？\x10:y＊\tι",
  ],
  [
    EncodeSingleQuote | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\tψι<１＇␁%\x14ο！ωνι␍␘＇Ｅ\x1db\x1e\x01iＱE＊;\t５",
    "～\tψι<１‛＇␁%\x14ο！ωνι␍␘‛＇Ｅ\x1db\x1e\x01iＱE＊;\t５",
  ],
  [
    EncodeBackQuote | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\t＼ξ:υＨ\r␌j?pｌρτλ\x02－␕\x06Ｅι\x02\v＇3c␂\t＝",
    "～\t＼ξ:υＨ\r␌j?pｌρτλ\x02－␕\x06Ｅι\x02\v＇3c␂\t＝",
  ],
  [
    EncodeLtGt | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\t!syπ\x14ａＳｅυＹυ\x1d␗ｐh［\x01␓βα/λh\x19\x10␙\t＃",
    "～\t!syπ\x14ａＳｅυＹυ\x1d␗ｐh［\x01␓βα/λh\x19\x10␙\t＃",
  ],
  [
    EncodeSquareBracket | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    '~\tfσ␓␗δI<ＯＹ␜&_\x1e␇η\n\x1cφ␙σ＄λ"l<［\t４',
    '～\tfσ␓␗δI<ＯＹ␜&_\x1e␇η\n\x1cφ␙σ＄λ"l<‛［\t４',
  ],
  [
    EncodeSemicolon | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\t␝ι\r>－\x00ωｕX␐νjI\x07ι５λ\\\uff00＼Ｇ␛\vψＰ\x14\tk",
    "～\t␝ι\r>－␀ωｕX␐νjI\x07ι５λ\\\uff00＼Ｇ␛\vψＰ\x14\tk",
  ],
  [
    EncodeExclamation | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\t␖2ｘκ␏<｛:\x1dη+/＃Uζ;$ψ'␜␎␖？4ｚＡ\tν",
    "～\t␖2ｘκ␏<｛:\x1dη+/＃Uζ;$ψ'␜␎␖？4ｚＡ\tν",
  ],
  [
    EncodeDollar | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\t&)Ｗ\f～］κＣω␝τＤm＠␌5\x00␋ψ\v*ｙψν␜/\tV",
    "～\t&)Ｗ\f～］κＣω␝τＤm＠␌5␀␋ψ\v*ｙψν␜/\tV",
  ],
  [
    EncodeDoubleQuote | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\t＊κ&#ω␄Ｎ＼］χd\x1b０\v;κ％\x10Ｔ1;ι＂2\x15\uff00\t␄",
    "～\t＊κ&#ω␄Ｎ＼］χd\x1b０\v;κ％\x10Ｔ1;ι‛＂2\x15\uff00\t␄",
  ],
  [
    EncodeColon | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\t␕␐χμ␞ｃ｜r%ςσ:G\x00＂φ<lｋσb／？\x03／\x1c\t８",
    "～\t␕␐χμ␞ｃ｜r%ςσ：G␀＂φ<lｋσb／？\x03／\x1c\t８",
  ],
  [
    EncodeQuestion | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\t\x00μJ[６θ␎␍ι＂ξｘｏ\x0e\x1f?\x026１S！:οＱ␄*\t␐",
    "～\t␀μJ[６θ␎␍ι＂ξｘｏ\x0e\x1f？\x026１S！:οＱ␄*\t␐",
  ],
  [
    EncodeAsterisk | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\t*␝＇>γ\x02８␞gｍr\x1fς\v＃␒\x0fd｜wτι：Ｉ␚τ\tσ",
    "～\t＊␝＇>γ\x02８␞gｍr\x1fς\v＃␒\x0fd｜wτι：Ｉ␚τ\tσ",
  ],
  [
    EncodePipe | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\tＨ＞？{%␉U９ｍ\x07κ\uff00[φ/(κQ␙］ο␗}ｍ＆|\tL",
    "～\tＨ＞？{%␉U９ｍ\x07κ\uff00[φ/(κQ␙］ο␗}ｍ＆｜\tL",
  ],
  [
    EncodeHash | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\t/␇\x07Ｖ＂ψ|λeＨγ\x1e␃\bｋλ\x10τ］␃J7～iＥ，\t8",
    "～\t/␇\x07Ｖ＂ψ|λeＨγ\x1e␃\bｋλ\x10τ］␃J7～iＥ，\t8",
  ],
  [
    EncodePercent | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\tＨｄ#［Ｒ9ασ\x00(\x17␚Jι５␚{ｊpＦ｜ζμ\x01\x03π\t＃",
    "～\tＨｄ#［Ｒ9ασ␀(\x17␚Jι５␚{ｊpＦ｜ζμ\x01\x03π\t＃",
  ],
  [
    EncodeBackSlash | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\tqrＨ6？υ␂－π6*｀ε␈\bS\x1b$$␏：/βλ\fγ\t＜",
    "～\tqrＨ6？υ␂－π6*｀ε␈\bS\x1b$$␏：/βλ\fγ\t＜",
  ],
  [
    EncodeDel | EncodeLeftTilde | EncodeLeftCrLfHtVt,
    "~\t\x18δＤ␅␖#ｇ｀Dt\\␝9\x00>ιλ?^β<␍Ｂ｀ηｐ\t＾",
    "～\t\x18δＤ␅␖#ｇ｀Dt\\␝9␀>ιλ?^β<␍Ｂ｀ηｐ\t＾",
  ],
  [
    EncodeZero | EncodeLeftTilde | EncodeRightSpace,
    '~ ？"β\x15ο=␍｜．Nｅ\x03｀GＺ\x10␊φdκ␇\x14ｇQμ\x01 ␜',
    '～ ？"β\x15ο=␍｜．Nｅ\x03｀GＺ\x10␊φdκ␇\x14ｇQμ\x01 ␜',
  ],
  [
    EncodeSlash | EncodeLeftTilde | EncodeRightSpace,
    '~ ［E\f＠\x0e\rγVθ"Ｏψε,\x03Ｄ／ｖｘ］b␡＄κ␌； ξ',
    '～ ［E\f＠\x0e\rγVθ"Ｏψε,\x03Ｄ‛／ｖｘ］b␡＄κ␌； ξ',
  ],
  [
    EncodeSingleQuote | EncodeLeftTilde | EncodeRightSpace,
    "~ +<ｈT␊；Ｋ\r\rω[π？bC␇αＧα/ｘψ\x12γL| ␓",
    "～ +<ｈT␊；Ｋ\r\rω[π？bC␇αＧα/ｘψ\x12γL| ␓",
  ],
  [
    EncodeBackQuote | EncodeLeftTilde | EncodeRightSpace,
    "~ ξ＄␊+：+\n％β：\x00\x1dβ\vｔ\x1aπ｜g*T．γ＼ι\uff00 `",
    "～ ξ＄␊+：+\n％β：␀\x1dβ\vｔ\x1aπ｜g*T．γ＼ι\uff00 ｀",
  ],
  [
    EncodeLtGt | EncodeLeftTilde | EncodeRightSpace,
    "~ \x05(υ＄␖␐\uff00～ζ␒;６；WＡμ.␄\x17ω\x01λρU4\t :",
    "～ \x05(υ＄␖␐\uff00～ζ␒;６；WＡμ.␄\x17ω\x01λρU4\t :",
  ],
  [
    EncodeSquareBracket | EncodeLeftTilde | EncodeRightSpace,
    '~ F}$ς\x00ｄ␉；&\x16"ε\x0fＺς＜?δκ｀I＄＂，Ｈ\v Ｘ',
    '～ F}$ς␀ｄ␉；&\x16"ε\x0fＺς＜?δκ｀I＄＂，Ｈ\v Ｘ',
  ],
  [
    EncodeSemicolon | EncodeLeftTilde | EncodeRightSpace,
    "~ χυ~|␆＂ｚ）␙\x15Ｖο\x1a\x04<iＦ＃␜Lκ\x1dｐ＼７ρ d",
    "～ χυ~|␆＂ｚ）␙\x15Ｖο\x1a\x04<iＦ＃␜Lκ\x1dｐ＼７ρ d",
  ],
  [
    EncodeExclamation | EncodeLeftTilde | EncodeRightSpace,
    "~ ＤT｜η／?ρ\x1b０\x14␆\x04ηＤο\x14{g％eＯ8＼2ε\x18 ␞",
    "～ ＤT｜η／?ρ\x1b０\x14␆\x04ηＤο\x14{g％eＯ8＼2ε\x18 ␞",
  ],
  [
    EncodeDollar | EncodeLeftTilde | EncodeRightSpace,
    "~ ρ＿＞Ｇ␟τ$!%\x19w␜[Ｔｇ␐#␞ ＼*δ␞nφ␎ \x06",
    "～ ρ＿＞Ｇ␟τ＄!%\x19w␜[Ｔｇ␐#␞ ＼*δ␞nφ␎ \x06",
  ],
  [
    EncodeDoubleQuote | EncodeLeftTilde | EncodeRightSpace,
    "~ \x10σ?｜/ς／y｜T>\x19␃＇κd␍ｃο％␕[␑＋2α H",
    "～ \x10σ?｜/ς／y｜T>\x19␃＇κd␍ｃο％␕[␑＋2α H",
  ],
  [
    EncodeColon | EncodeLeftTilde | EncodeRightSpace,
    '~ "␕：<␏ςς<UC␑\rｓｑμ\x10\x05β<ｌ␎＠1␆␁\x06 \n',
    '～ "␕‛：<␏ςς<UC␑\rｓｑμ\x10\x05β<ｌ␎＠1␆␁\x06 \n',
  ],
  [
    EncodeQuestion | EncodeLeftTilde | EncodeRightSpace,
    "~ ＃/\x16$λ7(>␀␐ρχ␊σ/L！．\x05!％！B␜？B Ｍ",
    "～ ＃/\x16$λ7(>‛␀␐ρχ␊σ/L！．\x05!％！B␜‛？B Ｍ",
  ],
  [
    EncodeAsterisk | EncodeLeftTilde | EncodeRightSpace,
    "~ ＊1＞π+␡π␓＊␌ο２]QＶ␝\x15＄#μβ\t#０(\r >",
    "～ ‛＊1＞π+␡π␓‛＊␌ο２]QＶ␝\x15＄#μβ\t#０(\r >",
  ],
  [
    EncodePipe | EncodeLeftTilde | EncodeRightSpace,
    "~ χ，］␃ρ<␈`RＩλ＠ζ\x12!d０`?＄＂χRγh␎ Ｐ",
    "～ χ，］␃ρ<␈`RＩλ＠ζ\x12!d０`?＄＂χRγh␎ Ｐ",
  ],
  [
    EncodeHash | EncodeLeftTilde | EncodeRightSpace,
    "~ ␛ε\x1e５␜\x03␇ＩＳτ!π␕γ；ο\f7ｄδx／KA<＇ ｏ",
    "～ ␛ε\x1e５␜\x03␇ＩＳτ!π␕γ；ο\f7ｄδx／KA<＇ ｏ",
  ],
  [
    EncodePercent | EncodeLeftTilde | EncodeRightSpace,
    "~ δYwν％Ｉ;\x11~\x12ｌsCＵ␘［φ６＞ｉ\x1e\x05cτ␘υ ＾",
    "～ δYwν‛％Ｉ;\x11~\x12ｌsCＵ␘［φ６＞ｉ\x1e\x05cτ␘υ ＾",
  ],
  [
    EncodeBackSlash | EncodeLeftTilde | EncodeRightSpace,
    "~ Ｔρ?ς␖*␑f␏[δτ␄OＣ\v#0␊ρｘ␌#5８ｆ u",
    "～ Ｔρ?ς␖*␑f␏[δτ␄OＣ\v#0␊ρｘ␌#5８ｆ u",
  ],
  [
    EncodeCrLf | EncodeLeftTilde | EncodeRightSpace,
    "~ \x15c＜Eｔ｀\x05！V\x12δλB␃␊ρｎ＝{πψ\x16?␄：μ ␡",
    "～ \x15c＜Eｔ｀\x05！V\x12δλB␃‛␊ρｎ＝{πψ\x16?␄：μ ␡",
  ],
  [
    EncodeDel | EncodeLeftTilde | EncodeRightSpace,
    "~ %６Ｒ␡＆\x1dzπω␀<␑\x1aσ␎ε＃\tωｒξ,?Ｎ`Ｏ ＼",
    "～ %６Ｒ‛␡＆\x1dzπω‛␀<␑\x1aσ␎ε＃\tωｒξ,?Ｎ`Ｏ ＼",
  ],
  [
    EncodeCtl | EncodeLeftTilde | EncodeRightSpace,
    '~ ｙＥ\x19ｍο"]%␀\x03ν\x04␆M_"＜／\bOπ７τ＄θ＃ \x10',
    '～ ｙＥ␙ｍο"]%‛␀␃ν␄‛␆M_"＜／␈Oπ７τ＄θ＃ ␐',
  ],
  [
    EncodeZero | EncodeLeftTilde | EncodeRightPeriod,
    "~.＊Ｐτλ[ｏ\x14！Ｐ␅␅η6ο!]xζｔξ[O％E\x1fＨ.＜",
    "～.＊Ｐτλ[ｏ\x14！Ｐ␅␅η6ο!]xζｔξ[O％E\x1fＨ.＜",
  ],
  [
    EncodeSlash | EncodeLeftTilde | EncodeRightPeriod,
    "~.ｔ;␅\n｜␍μ\x11x－␙Ｄu\x1f＼ｇ\x17νWＱ>δ\bλVψ.␖",
    "～.ｔ;␅\n｜␍μ\x11x－␙Ｄu\x1f＼ｇ\x17νWＱ>δ\bλVψ.␖",
  ],
  [
    EncodeSingleQuote | EncodeLeftTilde | EncodeRightPeriod,
    "~.\x18␄~␐Ｂθ\x1fν５ε，９／*X:ο␘ｌuι／5'｜\x00.θ",
    "～.\x18␄~␐Ｂθ\x1fν５ε，９／*X:ο␘ｌuι／5＇｜␀.θ",
  ],
  [
    EncodeBackQuote | EncodeLeftTilde | EncodeRightPeriod,
    "~.δ\x044␚Ｒ|VςｄＪ␜;｀uο｜=ｕ*：\x06\x11ηzκ｝.␙",
    "～.δ\x044␚Ｒ|VςｄＪ␜;‛｀uο｜=ｕ*：\x06\x11ηzκ｝.␙",
  ],
  [
    EncodeLtGt | EncodeLeftTilde | EncodeRightPeriod,
    '~.ｔ"Kυζ＃Fμ＞＋πν\x10ｕ␞(y␌\x16θ\x19\x00ｒ７b\x03.M',
    '～.ｔ"Kυζ＃Fμ‛＞＋πν\x10ｕ␞(y␌\x16θ\x19␀ｒ７b\x03.M',
  ],
  [
    EncodeSquareBracket | EncodeLeftTilde | EncodeRightPeriod,
    "~.*［＇｀#ηＫ!＞i7θ:\x1bωQ␎␈＇␐κ\x04βh-\x13.＜",
    "～.*‛［＇｀#ηＫ!＞i7θ:\x1bωQ␎␈＇␐κ\x04βh-\x13.＜",
  ],
  [
    EncodeSemicolon | EncodeLeftTilde | EncodeRightPeriod,
    "~.οχλ]＄\x1d\x05？␝６:ｋ\x14hｐZ␋␅γ｜ε␓#＂ｒ,.ψ",
    "～.οχλ]＄\x1d\x05？␝６:ｋ\x14hｐZ␋␅γ｜ε␓#＂ｒ,.ψ",
  ],
  [
    EncodeExclamation | EncodeLeftTilde | EncodeRightPeriod,
    "~.；I?\x14␘＊δU<ρ］K～πP␌μ'\x05［５５\t;ｒz.－",
    "～.；I?\x14␘＊δU<ρ］K～πP␌μ'\x05［５５\t;ｒz.－",
  ],
  [
    EncodeDollar | EncodeLeftTilde | EncodeRightPeriod,
    "~.iυφ\x04␉␀\x06*＋fｎγ␕H!１γz｛；χ7␅i＃\x07.＂",
    "～.iυφ\x04␉‛␀\x06*＋fｎγ␕H!１γz｛；χ7␅i＃\x07.＂",
  ],
  [
    EncodeDoubleQuote | EncodeLeftTilde | EncodeRightPeriod,
    "~.a］␡\x181␀ｄχ/5τm`．]\x1cｋ0Ｔνφ／η␙^ｅ.␃",
    "～.a］␡\x181‛␀ｄχ/5τm`．]\x1cｋ0Ｔνφ／η␙^ｅ.␃",
  ],
  [
    EncodeColon | EncodeLeftTilde | EncodeRightPeriod,
    "~.\x03␜␐>＂\x16\x15Ｄκ␕␞\x1f１ι）Ｏ␌!Ｌ␍\x16[\x04qn*.μ",
    "～.\x03␜␐>＂\x16\x15Ｄκ␕␞\x1f１ι）Ｏ␌!Ｌ␍\x16[\x04qn*.μ",
  ],
  [
    EncodeQuestion | EncodeLeftTilde | EncodeRightPeriod,
    "~.τ\x01␁οＳ<＋.[\x11２>B\x11ιβ␙＄␜:σ*ιＯ＂␇.␎",
    "～.τ\x01␁οＳ<＋.[\x11２>B\x11ιβ␙＄␜:σ*ιＯ＂␇.␎",
  ],
  [
    EncodeAsterisk | EncodeLeftTilde | EncodeRightPeriod,
    "~.\x17β\n\x06?Ｋ？；P␏␌γ＿ｍγ'␡#＊oθ␌η\x00ＲＣ.\\",
    "～.\x17β\n\x06?Ｋ？；P␏␌γ＿ｍγ'␡#‛＊oθ␌η␀ＲＣ.\\",
  ],
  [
    EncodePipe | EncodeLeftTilde | EncodeRightPeriod,
    '~.Y?ι(＄Ｉ?｜［u␃ｒ\r`\x1eα［．␚"_ηβμθ％.｝',
    '～.Y?ι(＄Ｉ?‛｜［u␃ｒ\r`\x1eα［．␚"_ηβμθ％.｝',
  ],
  [
    EncodeHash | EncodeLeftTilde | EncodeRightPeriod,
    "~.␘χ＜\\＿NG␅ζχ｝*\n｀ο<Ｋ＜[#␅\\\x18␑\x1dη.␚",
    "～.␘χ＜\\＿NG␅ζχ｝*\n｀ο<Ｋ＜[＃␅\\\x18␑\x1dη.␚",
  ],
  [
    EncodePercent | EncodeLeftTilde | EncodeRightPeriod,
    "~.\x10？3ρρＱ|␖κ；λ␋␒y＂z'␛\x18\x11␙\x1eP\x11ｓq.ς",
    "～.\x10？3ρρＱ|␖κ；λ␋␒y＂z'␛\x18\x11␙\x1eP\x11ｓq.ς",
  ],
  [
    EncodeBackSlash | EncodeLeftTilde | EncodeRightPeriod,
    '~.φ␄ν\x15$οZoｙ：φδ␑`．\x1f#＜C>␊␕$"lθ.Ｍ',
    '～.φ␄ν\x15$οZoｙ：φδ␑`．\x1f#＜C>␊␕$"lθ.Ｍ',
  ],
  [
    EncodeCrLf | EncodeLeftTilde | EncodeRightPeriod,
    "~.?|７＇j␊＂～\x10νq＃kζ！＊\r／H(φ\x175Ｘεκ.\x16",
    "～.?|７＇j‛␊＂～\x10νq＃kζ！＊␍／H(φ\x175Ｘεκ.\x16",
  ],
  [
    EncodeDel | EncodeLeftTilde | EncodeRightPeriod,
    '~.γ*L$␌e*ββ\x05\x1cＨ␐"Ｃσ$\x19␊[ ␜＠␃η！.．',
    '～.γ*L$␌e*ββ\x05\x1cＨ␐"Ｃσ$\x19␊[ ␜＠␃η！.‛．',
  ],
  [
    EncodeCtl | EncodeLeftTilde | EncodeRightPeriod,
    "~.`[Vｓ＼ν␁nφｖ～-ζ\x14<γ\uff00k\x1eK［μ␏␋\x18U.３",
    "～.`[Vｓ＼ν‛␁nφｖ～-ζ␔<γ\uff00k␞K［μ‛␏‛␋␘U.３",
  ],
  [
    EncodeZero | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\tＭ[\x05\x1baNξ＼οａυ:β␂ ι␁␁ｏ\x0eτ␏＜／\x04\x02\t\x1e",
    "～\tＭ[\x05\x1baNξ＼οａυ:β␂ ι␁␁ｏ\x0eτ␏＜／\x04\x02\t\x1e",
  ],
  [
    EncodeSlash | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\t｀0（␁＞Oγ（）ς\x11：\t␔σＦ%\x05τθ␊｜y＊\x11\x0e\tp",
    "～\t｀0（␁＞Oγ（）ς\x11：\t␔σＦ%\x05τθ␊｜y＊\x11\x0e\tp",
  ],
  [
    EncodeSingleQuote | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\t?π␆λ：＃ｇ␈␐εPαｃeωπＭ|t＠\x7f~1\x04\\\x03\t＂",
    "～\t?π␆λ：＃ｇ␈␐εPαｃeωπＭ|t＠\x7f~1\x04\\\x03\t＂",
  ],
  [
    EncodeBackQuote | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\t\x0e；\x10\x1d]ＮＶ␐~Nγyλ␕␎E*␚␔δkβＥ]ｕγ\tβ",
    "～\t\x0e；\x10\x1d]ＮＶ␐~Nγyλ␕␎E*␚␔δkβＥ]ｕγ\tβ",
  ],
  [
    EncodeLtGt | EncodeLeftTilde | EncodeRightCrLfHtVt,
    '~\t＾/␋/\r"\x02␞\r␅［d＊］ιＱ\x1bνν␄Ｏ␚\x1aQｐυ\tλ',
    '～\t＾/␋/\r"\x02␞\r␅［d＊］ιＱ\x1bνν␄Ｏ␚\x1aQｐυ\tλ',
  ],
  [
    EncodeSquareBracket | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\tＺδ␉７>ψｗ\fw>8ι!␍\v␏␘␃n␇\nb\x03Tζｖ\tφ",
    "～\tＺδ␉７>ψｗ\fw>8ι!␍\v␏␘␃n␇\nb\x03Tζｖ\tφ",
  ],
  [
    EncodeSemicolon | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\tθ＃ε\r3tYｆιχａ＾\t3 θ＃ε\x1eＰ\x16B＞％␋␙\t＇",
    "～\tθ＃ε\r3tYｆιχａ＾\t3 θ＃ε\x1eＰ\x16B＞％␋␙\t＇",
  ],
  [
    EncodeExclamation | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\tＬ\uff00Ｊｑ␊ψ\x02;xζ␊％Ｇ\x0eε;ηvD`ο␚（␃x␛\tg",
    "～\tＬ\uff00Ｊｑ␊ψ\x02;xζ␊％Ｇ\x0eε;ηvD`ο␚（␃x␛\tg",
  ],
  [
    EncodeDollar | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\t９ω：Ｔ＞C％？␅.γ.＄εν␄（ｚρ\x143␎/8\x1fσ\t]",
    "～\t９ω：Ｔ＞C％？␅.γ.‛＄εν␄（ｚρ\x143␎/8\x1fσ\t]",
  ],
  [
    EncodeDoubleQuote | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\t␕νδο\x04＂φτβ８4\x01；␉０\":␐／\x06＇？`'Gｙ\t0",
    "～\t␕νδο\x04‛＂φτβ８4\x01；␉０＂:␐／\x06＇？`'Gｙ\t0",
  ],
  [
    EncodeColon | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\tＮ\x00\x12α␛␗\f＠φ＜/χ:ｉ~␒τρν( 4\x1cｈ＄ｐ\tＴ",
    "～\tＮ␀\x12α␛␗\f＠φ＜/χ：ｉ~␒τρν( 4\x1cｈ＄ｐ\tＴ",
  ],
  [
    EncodeQuestion | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\tθ␄μＹπ－/␃\v␡Ｅ－\x13(#;；e/γ＂w\x16\x10␗κ\tρ",
    "～\tθ␄μＹπ－/␃\v␡Ｅ－\x13(#;；e/γ＂w\x16\x10␗κ\tρ",
  ],
  [
    EncodeAsterisk | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\t＋4;；ομ\n]␞＇\x17B５％␃\n＊Ｈ␏κ*τ/｜πZ\tβ",
    "～\t＋4;；ομ\n]␞＇\x17B５％␃\n‛＊Ｈ␏κ＊τ/｜πZ\tβ",
  ],
  [
    EncodePipe | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\t␞U\x1bｏLθ␓\x13＜zo␏ｔ:\x0fεRτ＄!\x1e␀＊λ＃ζ\tε",
    "～\t␞U\x1bｏLθ␓\x13＜zo␏ｔ:\x0fεRτ＄!\x1e‛␀＊λ＃ζ\tε",
  ],
  [
    EncodeHash | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\t\x1e*６␌Ｒ\x18Ｋυk$＆X;＋W＼d［\x10μβςς ␄\f\t＜",
    "～\t\x1e*６␌Ｒ\x18Ｋυk$＆X;＋W＼d［\x10μβςς ␄\f\t＜",
  ],
  [
    EncodePercent | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\t␅\x02ξ\"tγ␑\x13４＇␔'R＊ｕDｌＰｍ\x04␆nρο␟τ\t#",
    "～\t␅\x02ξ\"tγ␑\x13４＇␔'R＊ｕDｌＰｍ\x04␆nρο␟τ\t#",
  ],
  [
    EncodeBackSlash | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\tω％*αιF[＂␍v＿φ␂６␌i\x1ca／q\x1eＣAω＼：\t\\",
    "～\tω％*αιF[＂␍v＿φ␂６␌i\x1ca／q\x1eＣAω‛＼：\t＼",
  ],
  [
    EncodeDel | EncodeLeftTilde | EncodeRightCrLfHtVt,
    "~\tｖι0␀＼'␀mＲ\x03'λｄ-\x05ｄ！：Ｘβ␏JCθ％ι\t\f",
    "～\tｖι0‛␀＼'‛␀mＲ\x03'λｄ-\x05ｄ！：Ｘβ␏JCθ％ι\t\f",
  ],
  [
    EncodeZero | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t 8rψＩ'\x1d\x1d␎αμ5␊Ｓδ`[Ｍ␜␈gF␌λ<５： －",
    "␉ 8rψＩ'\x1d\x1d␎αμ5␊Ｓδ`[Ｍ␜␈gF␌λ<５： －",
  ],
  [
    EncodeSlash | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t Ｃ／[/\x7fφ>␃φ３＊ρ\x03９vκＮoXψπU＼CL０ ␍",
    "␉ Ｃ‛／[／\x7fφ>␃φ３＊ρ\x03９vκＮoXψπU＼CL０ ␍",
  ],
  [
    EncodeSingleQuote | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t 2φ␍；␚ｘMτ｜T␏Ｘ(ｐλ｜<κ\x11`＇/ρ;:␝ β",
    "␉ 2φ␍；␚ｘMτ｜T␏Ｘ(ｐλ｜<κ\x11`‛＇/ρ;:␝ β",
  ],
  [
    EncodeBackQuote | EncodeLeftCrLfHtVt | EncodeRightSpace,
    '\t ␆\x1f；1ιδ？␜＜ρQｕEτ␌e\x06ζ\x0f"［β8␈\x1c! \x05',
    '␉ ␆\x1f；1ιδ？␜＜ρQｕEτ␌e\x06ζ\x0f"［β8␈\x1c! \x05',
  ],
  [
    EncodeLtGt | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t ｑβ␘＇\x02Kχ\x1b，｀μk\x0fνｕＡＭω␗\x13n$］2υ! p",
    "␉ ｑβ␘＇\x02Kχ\x1b，｀μk\x0fνｕＡＭω␗\x13n$］2υ! p",
  ],
  [
    EncodeSquareBracket | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t ␟｛\x18α:ｇzρψkLξ；＊␊\r␋\x03｀&Ｐ>~％．\x13 d",
    "␉ ␟｛\x18α:ｇzρψkLξ；＊␊\r␋\x03｀&Ｐ>~％．\x13 d",
  ],
  [
    EncodeSemicolon | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t ρＲ\fα%$＊%（@$\\␙h[␅ςＡβ␟␘ｉＲφE\x01 ω",
    "␉ ρＲ\fα%$＊%（@$\\␙h[␅ςＡβ␟␘ｉＲφE\x01 ω",
  ],
  [
    EncodeExclamation | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t δ7］π\x0e；C6ο３␃:%\x04␍－ｘ␘b%␈ｏουε# ！",
    "␉ δ7］π\x0e；C6ο３␃:%\x04␍－ｘ␘b%␈ｏουε# ‛！",
  ],
  [
    EncodeDollar | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t  ι\x17κτωＲψMＰ]ｒ＃\\␜０␀X?ｃ\x15␈Ｐ［(τ Q",
    "␉  ι\x17κτωＲψMＰ]ｒ＃\\␜０‛␀X?ｃ\x15␈Ｐ［(τ Q",
  ],
  [
    EncodeDoubleQuote | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t ␈Wφη7ＺＥρω］f|＂V．Ij\\␁＜\x0e|γ\x17\v＋ τ",
    "␉ ␈Wφη7ＺＥρω］f|‛＂V．Ij\\␁＜\x0e|γ\x17\v＋ τ",
  ],
  [
    EncodeColon | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t d,γh\f５ι*G␡；＼＼ｏ␑\x05␁＼ε７ζb!!␁μ ς",
    "␉ d,γh\f５ι*G␡；＼＼ｏ␑\x05␁＼ε７ζb!!␁μ ς",
  ],
  [
    EncodeQuestion | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t \x11｝\x15｀＜，\x13␍\x19␓␅ｇ\r~␛␜ωu＆β：8ς4α\x00 R",
    "␉ \x11｝\x15｀＜，\x13␍\x19␓␅ｇ\r~␛␜ωu＆β：8ς4α␀ R",
  ],
  [
    EncodeAsterisk | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t ␁]Ａ：\x16ａ␍＜ｇm\x17βη\x12KψｐdＣλ\f［\x18ιW␖ Ｘ",
    "␉ ␁]Ａ：\x16ａ␍＜ｇm\x17βη\x12KψｐdＣλ\f［\x18ιW␖ Ｘ",
  ],
  [
    EncodePipe | EncodeLeftCrLfHtVt | EncodeRightSpace,
    '\t ωａGλ<"ω＞"u\x7f｀␛\x04３ｚε\x04+=␉␍β\x06␆ｙ ␟',
    '␉ ωａGλ<"ω＞"u\x7f｀␛\x04３ｚε\x04+=␉␍β\x06␆ｙ ␟',
  ],
  [
    EncodeHash | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t ␊β␉６λ／␃δｍ/JπＰ??\x0fｏ＋7*φξg␙l\x1a ␆",
    "␉ ␊β␉６λ／␃δｍ/JπＰ??\x0fｏ＋7*φξg␙l\x1a ␆",
  ],
  [
    EncodePercent | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t π8ｘ！+ｂ␂$?*＠nχ6#｜λψ]δｙｓ｜＜W\r ␞",
    "␉ π8ｘ！+ｂ␂$?*＠nχ6#｜λψ]δｙｓ｜＜W\r ␞",
  ],
  [
    EncodeBackSlash | EncodeLeftCrLfHtVt | EncodeRightSpace,
    '\t I"ｇ\uff00␀␍ｖ%z(＊ω<ｒ\n*κ!；\r␂ｐτφ␒ε ＆',
    '␉ I"ｇ\uff00‛␀␍ｖ%z(＊ω<ｒ\n*κ!；\r␂ｐτφ␒ε ＆',
  ],
  [
    EncodeDel | EncodeLeftCrLfHtVt | EncodeRightSpace,
    "\t ο\x04？；＿␈␗ξκ?［\x1b＄τＦ2ςS\x14}5φＧ'Ｎ\v \t",
    "␉ ο\x04？；＿␈␗ξκ?［\x1b＄τＦ2ςS\x14}5φＧ'Ｎ\v \t",
  ],
  [
    EncodeZero | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.\x18Ｂ\x17ηο;ν\x05p␜γ＜}␑\vＮ｛ＳＷ<ｅ␊\x05␍w\x1a.␈",
    "␉.\x18Ｂ\x17ηο;ν\x05p␜γ＜}␑\vＮ｛ＳＷ<ｅ␊\x05␍w\x1a.␈",
  ],
  [
    EncodeSlash | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.>ρ␘φA␊␘η（&#）(\n␒１\x1c#+␈ｎθ］\x14\x1dｙ.φ",
    "␉.>ρ␘φA␊␘η（&#）(\n␒１\x1c#+␈ｎθ］\x14\x1dｙ.φ",
  ],
  [
    EncodeSingleQuote | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.5θ\x10\x14｀ｋJ\x19δ␐Ｔ＼2\x12｀\x00νπ;\x16ＦV＝ο]␒.Ｎ",
    "␉.5θ\x10\x14｀ｋJ\x19δ␐Ｔ＼2\x12｀␀νπ;\x16ＦV＝ο]␒.Ｎ",
  ],
  [
    EncodeBackQuote | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.␐␍9\x10？␇Ｆν\\λ［υξ\n␔#'3#ρＴ＃%φI？.O",
    "␉.␐␍9\x10？␇Ｆν\\λ［υξ\n␔#'3#ρＴ＃%φI？.O",
  ],
  [
    EncodeLtGt | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.\x1fｘσ␎␘'｜＠a␂ζφ$\x15\x02P／J␕υς\x1fi％＝\x1e.O",
    "␉.\x1fｘσ␎␘'｜＠a␂ζφ$\x15\x02P／J␕υς\x1fi％＝\x1e.O",
  ],
  [
    EncodeSquareBracket | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.αＬεη␌］\bJββ！su｜＞χ;３\x14 \x1f\x01\x0e␊␍8.\x12",
    "␉.αＬεη␌‛］\bJββ！su｜＞χ;３\x14 \x1f\x01\x0e␊␍8.\x12",
  ],
  [
    EncodeSemicolon | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.］＂` }␔wη␋μ␊８dζ\nｅηR\x15#;Ｆ＄!ｄο.＞",
    "␉.］＂` }␔wη␋μ␊８dζ\nｅηR\x15#；Ｆ＄!ｄο.＞",
  ],
  [
    EncodeExclamation | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.ξςZA４Ｔσ␖␔Bζ：:μ␌Ｏ\x13*］＞［\x13>θt\n.\x00",
    "␉.ξςZA４Ｔσ␖␔Bζ：:μ␌Ｏ\x13*］＞［\x13>θt\n.␀",
  ],
  [
    EncodeDollar | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.\x1dτ␙６φ&\x07Ｂ＜+.\n＼!／␛\x0f␎ληδε>␜\x07％.M",
    "␉.\x1dτ␙６φ&\x07Ｂ＜+.\n＼!／␛\x0f␎ληδε>␜\x07％.M",
  ],
  [
    EncodeDoubleQuote | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    '\t.ζ␎～\n␇"XνＳ␉␊\x068\x1e6＞ξo，ｐυv#ωοｂ.a',
    "␉.ζ␎～\n␇＂XνＳ␉␊\x068\x1e6＞ξo，ｐυv#ωοｂ.a",
  ],
  [
    EncodeColon | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.\x01␍}πνｆｑτμ，F\f/Ｐ！\x18␚］.ς␁'＄<\x1eｌ.τ",
    "␉.\x01␍}πνｆｑτμ，F\f/Ｐ！\x18␚］.ς␁'＄<\x1eｌ.τ",
  ],
  [
    EncodeQuestion | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.＞ｐ＇\x14＜υ％␊Lχ␏｀!B]｜Xｕγ\x03␖rξ/\x17！.d",
    "␉.＞ｐ＇\x14＜υ％␊Lχ␏｀!B]｜Xｕγ\x03␖rξ/\x17！.d",
  ],
  [
    EncodeAsterisk | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.η＞ζ＝ς\x1cＪ␌＄ν＞\rｖＧ$ａ`'L\x0e}＜P␆/{.␊",
    "␉.η＞ζ＝ς\x1cＪ␌＄ν＞\rｖＧ$ａ`'L\x0e}＜P␆/{.␊",
  ],
  [
    EncodePipe | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.␍SＲＪＬυ$␖｜ＵVGVφ␙]＄␝␟l?\r\v'ςλ.υ",
    "␉.␍SＲＪＬυ$␖‛｜ＵVGVφ␙]＄␝␟l?\r\v'ςλ.υ",
  ],
  [
    EncodeHash | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.Ｆ３O␑λＨ␈ο+'＆.|｜＆ψ\x7f:μ\x03␈ｉ\\!␑[.θ",
    "␉.Ｆ３O␑λＨ␈ο+'＆.|｜＆ψ\x7f:μ\x03␈ｉ\\!␑[.θ",
  ],
  [
    EncodePercent | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.6＂＃Ｍ／aσβTZ␑βｅ>β｀ｔς␈ψ)Ｍ\x18\x07␖\x18.R",
    "␉.6＂＃Ｍ／aσβTZ␑βｅ>β｀ｔς␈ψ)Ｍ\x18\x07␖\x18.R",
  ],
  [
    EncodeBackSlash | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t.\x17\x10ιf␌ς＇␌］\x04ςν%ιＬＡζ␈9\uff00␕P\x1cｗ␙-.U",
    "␉.\x17\x10ιf␌ς＇␌］\x04ςν%ιＬＡζ␈9\uff00␕P\x1cｗ␙-.U",
  ],
  [
    EncodeDel | EncodeLeftCrLfHtVt | EncodeRightPeriod,
    "\t./␙ｕ&\x7f\x0f␍␎Ｌω/＄＿π\x16ω6␘ηＨｃθ？␝=ρ. ",
    "␉./␙ｕ&␡\x0f␍␎Ｌω/＄＿π\x16ω6␘ηＨｃθ？␝=ρ. ",
  ],
  [
    EncodeZero | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\tｃ_Ｘ\x7fε\x7f％ｌτρFξＪc&␌␗l\x11Ｓ(;␌－\x16\x01\t␂",
    "␉\tｃ_Ｘ\x7fε\x7f％ｌτρFξＪc&␌␗l\x11Ｓ(;␌－\x16\x01\t␂",
  ],
  [
    EncodeSlash | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\tＰ［o\x16␖Ｂ.;!β]\x06＝␊␜␉f␔$s␂γξ\uff00ｍδ\tπ",
    "␉\tＰ［o\x16␖Ｂ.;!β]\x06＝␊␜␉f␔$s␂γξ\uff00ｍδ\tπ",
  ],
  [
    EncodeSingleQuote | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\tＷｓ\x1bＧ\x04με\x0exηI!？w］b␔！␈＆\n*ξ\x1bτ％\t3",
    "␉\tＷｓ\x1bＧ\x04με\x0exηI!？w］b␔！␈＆\n*ξ\x1bτ％\t3",
  ],
  [
    EncodeBackQuote | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\tＶ<F␛␇ληOφ1ｎ\x07＇|.AＣｂｆ？\x03\x0eοω\nＨ\t；",
    "␉\tＶ<F␛␇ληOφ1ｎ\x07＇|.AＣｂｆ？\x03\x0eοω\nＨ\t；",
  ],
  [
    EncodeLtGt | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\t␇\x1dθ␕\b\x0e＜ν␍］＝<9␑7６πe\rＤRv＄|：i\tε",
    "␉\t␇\x1dθ␕\b\x0e‛＜ν␍］＝＜9␑7６πe\rＤRv＄|：i\tε",
  ],
  [
    EncodeSquareBracket | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\t;λ␗␐;λ<␋/\x07;η２2RB＼\x11\x03ς９７６\x0fσＹ\tρ",
    "␉\t;λ␗␐;λ<␋/\x07;η２2RB＼\x11\x03ς９７６\x0fσＹ\tρ",
  ],
  [
    EncodeSemicolon | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    '\t\t␜DDα␌\x1bθ＿"\rＪ␍：κτ␅\x12"ａ>π\x0e＂\rαＸ\t␏',
    '␉\t␜DDα␌\x1bθ＿"\rＪ␍：κτ␅\x12"ａ>π\x0e＂\rαＸ\t␏',
  ],
  [
    EncodeExclamation | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\t'`ζＡ=τ\nＵ［␖R6Ｕ\x19`B３ψφR␞␎␁！m␈\t\x0e",
    "␉\t'`ζＡ=τ\nＵ［␖R6Ｕ\x19`B３ψφR␞␎␁‛！m␈\t\x0e",
  ],
  [
    EncodeDollar | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\t*\x02＠␔LτM｛␃C␊␘I\x17ＳｏαW␚οＣ␈'｜\x17d\tβ",
    "␉\t*\x02＠␔LτM｛␃C␊␘I\x17ＳｏαW␚οＣ␈'｜\x17d\tβ",
  ],
  [
    EncodeDoubleQuote | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\tψς␔8R[\x12ｆｖ␐ψ｜θ'|？PT\r！\x03ｑρ７␜＊\t\v",
    "␉\tψς␔8R[\x12ｆｖ␐ψ｜θ'|？PT\r！\x03ｑρ７␜＊\t␋",
  ],
  [
    EncodeColon | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\tＫςｖξ５\x19＊Ｒ␍？^ｙn\x15Ｖνθ␞␟］χοl/\x17k\t\x18",
    "␉\tＫςｖξ５\x19＊Ｒ␍？^ｙn\x15Ｖνθ␞␟］χοl/\x17k\t\x18",
  ],
  [
    EncodeQuestion | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\t\x1c<␉\x1cψ{␖\n？ξ␁YｇψＡ５\x13␅Cｖζ\x11f␄Y;\tο",
    "␉\t\x1c<␉\x1cψ{␖\n‛？ξ␁YｇψＡ５\x13␅Cｖζ\x11f␄Y;\tο",
  ],
  [
    EncodeAsterisk | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\tυU␉σ9<8θ－␒\x00␊O％＜f\x00\x14ＮＪαζ#＼␗１\t\x19",
    "␉\tυU␉σ9<8θ－␒␀␊O％＜f␀\x14ＮＪαζ#＼␗１\t\x19",
  ],
  [
    EncodePipe | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\t␔＄ＶοNｗCω/αY＼␋<`ＤZ＊lγw\x19＆＇；／\t<",
    "␉\t␔＄ＶοNｗCω/αY＼␋<`ＤZ＊lγw\x19＆＇；／\t<",
  ],
  [
    EncodeHash | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\t␄␂&＾；εςN/g｀|α\f\x1aξＵＫE␏nＲＺ>\\␘\tζ",
    "␉\t␄␂&＾；εςN/g｀|α\f\x1aξＵＫE␏nＲＺ>\\␘\tζ",
  ],
  [
    EncodePercent | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\t␞␕］>γBIＧ３κ\x18␓\x05#\\ａγ␆υ～δ\x07r*｝＇\t｀",
    "␉\t␞␕］>γBIＧ３κ\x18␓\x05#\\ａγ␆υ～δ\x07r*｝＇\t｀",
  ],
  [
    EncodeBackSlash | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    '\t\t\x12＼"Ｋ␟τ＊p［ε␐｛u␑[\vκ\x15Ｂ␗=\x16␓μπr\t:',
    '␉\t\x12‛＼"Ｋ␟τ＊p［ε␐｛u␑[\vκ\x15Ｂ␗=\x16␓μπr\t:',
  ],
  [
    EncodeDel | EncodeLeftCrLfHtVt | EncodeRightCrLfHtVt,
    "\t\tς\x10y␖ν｛｜\x0e＃＼＃'θ｛λＹf␜α`i｛\x0f\x11␈m\tR",
    "␉\tς\x10y␖ν｛｜\x0e＃＼＃'θ｛λＹf␜α`i｛\x0f\x11␈m\tR",
  ],
  [
    EncodeZero | EncodeRightSpace | EncodeRightPeriod,
    " .：εｇ6ＤF␁?\x1e@\\\x01＂\x16?νχα\x7f＂７␑Ｊε␝␄.γ",
    " .：εｇ6ＤF␁?\x1e@\\\x01＂\x16?νχα\x7f＂７␑Ｊε␝␄.γ",
  ],
  [
    EncodeSlash | EncodeRightSpace | EncodeRightPeriod,
    " .Zi%\rｑ␈ζηb４Eψ＃ｐ\v｀／'Ｄ\x02(`␊α#ρ.τ",
    " .Zi%\rｑ␈ζηb４Eψ＃ｐ\v｀‛／'Ｄ\x02(`␊α#ρ.τ",
  ],
  [
    EncodeSingleQuote | EncodeRightSpace | EncodeRightPeriod,
    " .\x1e␋？ζ\rζ;ρi4␛;υ?\rν␔１ι␇ａk／)ｄｋ.９",
    " .\x1e␋？ζ\rζ;ρi4␛;υ?\rν␔１ι␇ａk／)ｄｋ.９",
  ],
  [
    EncodeBackQuote | EncodeRightSpace | EncodeRightPeriod,
    ' .ｒ"␓Ｕψ＂αδυ1ｓ␆\rdｖ@rQ$rｕμ␍φ：（.␡',
    ' .ｒ"␓Ｕψ＂αδυ1ｓ␆\rdｖ@rQ$rｕμ␍φ：（.␡',
  ],
  [
    EncodeLtGt | EncodeRightSpace | EncodeRightPeriod,
    ' .I＠␊４\x12ｄｔo\x1e)␊␖|εοQ\x12＊δ␎x"？Ｎγ9.\b',
    ' .I＠␊４\x12ｄｔo\x1e)␊␖|εοQ\x12＊δ␎x"？Ｎγ9.\b',
  ],
  [
    EncodeSquareBracket | EncodeRightSpace | EncodeRightPeriod,
    " .χ]＇\nD４／ct［'\x14ε;␇\x15ｅο）P␖χ４χσ␞.ｒ",
    " .χ］＇\nD４／ct‛［'\x14ε;␇\x15ｅο）P␖χ４χσ␞.ｒ",
  ],
  [
    EncodeSemicolon | EncodeRightSpace | EncodeRightPeriod,
    " .\x19mＳ*｜W:Ｓ1＋>ηθ\x16φκ=␗;％μＮ␋β␟］.\x00",
    " .\x19mＳ*｜W:Ｓ1＋>ηθ\x16φκ=␗；％μＮ␋β␟］.␀",
  ],
  [
    EncodeExclamation | EncodeRightSpace | EncodeRightPeriod,
    " .M］'σ\x1eN＂｜$？␍>*Dε|（ψn␂θx␟ζ０υ.!",
    " .M］'σ\x1eN＂｜$？␍>*Dε|（ψn␂θx␟ζ０υ.！",
  ],
  [
    EncodeDollar | EncodeRightSpace | EncodeRightPeriod,
    ' .％\x11\vδ␐"＠z␏π%@１ｑ\x1f～VＧ␈｀ςω␖υ\bR.υ',
    ' .％\x11\vδ␐"＠z␏π%@１ｑ\x1f～VＧ␈｀ςω␖υ\bR.υ',
  ],
  [
    EncodeDoubleQuote | EncodeRightSpace | EncodeRightPeriod,
    " .g#;ψ［ｔ␋Ｉ6～%＄＜σ／πσ[\x16`kY｝-＃｀.－",
    " .g#;ψ［ｔ␋Ｉ6～%＄＜σ／πσ[\x16`kY｝-＃｀.－",
  ],
  [
    EncodeColon | EncodeRightSpace | EncodeRightPeriod,
    " .␖\x16\x17ρκD？h９9\x00＃E,\t[␍｛ＵHχ：ｉ␈'δ.ψ",
    " .␖\x16\x17ρκD？h９9␀＃E,\t[␍｛ＵHχ‛：ｉ␈'δ.ψ",
  ],
  [
    EncodeQuestion | EncodeRightSpace | EncodeRightPeriod,
    " .／%Ｉo\x1b１χＴ＇\x01ｓ␟ωJ;τα\vＢ，＊η\x12υ＂,.;",
    " .／%Ｉo\x1b１χＴ＇\x01ｓ␟ωJ;τα\vＢ，＊η\x12υ＂,.;",
  ],
  [
    EncodeAsterisk | EncodeRightSpace | EncodeRightPeriod,
    " .␛／␎φ｜>！\x00␒\x06\x1fο＆\x127␇ａ␆$οςθ2k,w.＾",
    " .␛／␎φ｜>！␀␒\x06\x1fο＆\x127␇ａ␆$οςθ2k,w.＾",
  ],
  [
    EncodePipe | EncodeRightSpace | EncodeRightPeriod,
    " .επ␛␖σ％\x7fλＶｕ␏3ω\n％\tc/ｂ\x03ν␞Ｗ$＇3.Ｎ",
    " .επ␛␖σ％\x7fλＶｕ␏3ω\n％\tc/ｂ\x03ν␞Ｗ$＇3.Ｎ",
  ],
  [
    EncodeHash | EncodeRightSpace | EncodeRightPeriod,
    " .Ｊ｜ｚＬｊ␏B\r␍`␒:>␘1νωh［Yξ\x10θ␊Ｔ?.\x14",
    " .Ｊ｜ｚＬｊ␏B\r␍`␒:>␘1νωh［Yξ\x10θ␊Ｔ?.\x14",
  ],
  [
    EncodePercent | EncodeRightSpace | EncodeRightPeriod,
    " .\x0eτｅTh>θ␕\x17ρＤ#q＼␐κ#+\x12ν*？␇７ｙｂ.η",
    " .\x0eτｅTh>θ␕\x17ρＤ#q＼␐κ#+\x12ν*？␇７ｙｂ.η",
  ],
  [
    EncodeBackSlash | EncodeRightSpace | EncodeRightPeriod,
    " .\tＷ＊\x17Jμ｀Ｌ?2m\nｅ＂R［α␅\x18＃／ｕι\x15νο.ο",
    " .\tＷ＊\x17Jμ｀Ｌ?2m\nｅ＂R［α␅\x18＃／ｕι\x15νο.ο",
  ],
  [
    EncodeCrLf | EncodeRightSpace | EncodeRightPeriod,
    " .λJｈｐ｀γ␊＠３*␐ητ＂w␄>（θ\x14\x06u<pω\\.＜",
    " .λJｈｐ｀γ‛␊＠３*␐ητ＂w␄>（θ\x14\x06u<pω\\.＜",
  ],
  [
    EncodeDel | EncodeRightSpace | EncodeRightPeriod,
    " .?ζφ？\x1dβ␆\t␊αＹN\n␕5␔;］␑＊SＨ:Ｇsθ.ς",
    " .?ζφ？\x1dβ␆\t␊αＹN\n␕5␔;］␑＊SＨ:Ｇsθ.ς",
  ],
  [
    EncodeCtl | EncodeRightSpace | EncodeRightPeriod,
    ' .5φ\x04lBｘ＾λ，ｎ\f％␏␉φαＫθr&␡d␍\x07"ｖ.φ',
    ' .5φ␄lBｘ＾λ，ｎ␌％‛␏‛␉φαＫθr&␡d‛␍␇"ｖ.φ',
  ],
  [
    EncodeZero | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \t\\q８|［␎ρGχＯ\x7f\x02＊␀<Ib／␗\fＳ\x00α＿/ｘ\tλ",
    " \t\\q８|［␎ρGχＯ\x7f\x02＊‛␀<Ib／␗\fＳ␀α＿/ｘ\tλ",
  ],
  [
    EncodeSlash | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \t\x1fＳι␗\x06\x10ｖrω␇８7v␞vξγ？＇Dｇg\x1e\x15\x02Ｍ\t＇",
    " \t\x1fＳι␗\x06\x10ｖrω␇８7v␞vξγ？＇Dｇg\x1e\x15\x02Ｍ\t＇",
  ],
  [
    EncodeSingleQuote | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \tφι＼/％>：5ｔ-＜]␊＜\x14ｗＱqK\x12,υσ␀λ\x1b\t=",
    " \tφι＼/％>：5ｔ-＜]␊＜\x14ｗＱqK\x12,υσ‛␀λ\x1b\t=",
  ],
  [
    EncodeBackQuote | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \t\x1d|１)χｌ!ｚι\x03␚＼\x11␜N␝λ?\x19δ４j-␞␡\x1e\tｋ",
    " \t\x1d|１)χｌ!ｚι\x03␚＼\x11␜N␝λ?\x19δ４j-␞␡\x1e\tｋ",
  ],
  [
    EncodeLtGt | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \t，␑：]σ7６３f␍␏;ｃn\x1e?\x0f\x0eb$␒\x03σζ；Ｅ\tε",
    " \t，␑：]σ7６３f␍␏;ｃn\x1e?\x0f\x0eb$␒\x03σζ；Ｅ\tε",
  ],
  [
    EncodeSquareBracket | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \t\x0ew\x1cr］\\ＴιμＣ＠`\x7fς\x04␒␐κ｀␁␜6K\x19␘ι\t）",
    " \t\x0ew\x1cr‛］\\ＴιμＣ＠`\x7fς\x04␒␐κ｀␁␜6K\x19␘ι\t）",
  ],
  [
    EncodeSemicolon | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \t`［ｔ\n６\v?？οVχ3ηυ␍ι｀：\x06X␑9Ｏ␆␍$\tα",
    " \t`［ｔ\n６\v?？οVχ3ηυ␍ι｀：\x06X␑9Ｏ␆␍$\tα",
  ],
  [
    EncodeExclamation | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \t$/v]␂nο␓␈Ｚ␆y\x04ηπXEδP（Ｓ\x14␓␍ιｉ\tＴ",
    " \t$/v]␂nο␓␈Ｚ␆y\x04ηπXEδP（Ｓ\x14␓␍ιｉ\tＴ",
  ],
  [
    EncodeDollar | EncodeRightSpace | EncodeRightCrLfHtVt,
    ' \tｐ］"＾％␘ι;δ␅＞v\x1eρ`＾｀；δe(ψ␑Uυ8\t］',
    ' \tｐ］"＾％␘ι;δ␅＞v\x1eρ`＾｀；δe(ψ␑Uυ8\t］',
  ],
  [
    EncodeDoubleQuote | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \tβf/［ｂλ\x02Ｓ␃zHν\x1e\x04π\x1dπ␐␙ｂBX␇Ｋａj\t␟",
    " \tβf/［ｂλ\x02Ｓ␃zHν\x1e\x04π\x1dπ␐␙ｂBX␇Ｋａj\t␟",
  ],
  [
    EncodeColon | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \tn␟l＂＃＾\\\vｉψιβο#6Ｃ␚ｚ␓\uff00\x13ｈm_\x13␓\t/",
    " \tn␟l＂＃＾\\\vｉψιβο#6Ｃ␚ｚ␓\uff00\x13ｈm_\x13␓\t/",
  ],
  [
    EncodeQuestion | EncodeRightSpace | EncodeRightCrLfHtVt,
    ' \t_／＆３ｏθ\x16␍␕"ｙω：\x1a+＜ι\x03\x0f\x03VF＼ξμ"\tψ',
    ' \t_／＆３ｏθ\x16␍␕"ｙω：\x1a+＜ι\x03\x0f\x03VF＼ξμ"\tψ',
  ],
  [
    EncodeAsterisk | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \t␒~.\x1b+5χ\x11␊］π％Hρ＿κ３ω｀␍\x00␡ｔＬg\r\t/",
    " \t␒~.\x1b+5χ\x11␊］π％Hρ＿κ３ω｀␍␀␡ｔＬg\r\t/",
  ],
  [
    EncodePipe | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \t βｍＣ␃ｆ\rIν␡\x0f)\uff00\x15\rζ－}＄`χ<｜␇\x18␚\t%",
    " \t βｍＣ␃ｆ\rIν␡\x0f)\uff00\x15\rζ－}＄`χ<‛｜␇\x18␚\t%",
  ],
  [
    EncodeHash | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \t`<＜#\x07J\x16Ｃσｃκχｆｚ#３Aλx␅␄＼＂υdE\t!",
    " \t`<＜＃\x07J\x16Ｃσｃκχｆｚ＃３Aλx␅␄＼＂υdE\t!",
  ],
  [
    EncodePercent | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \t\x1dＭ\n9\x1b␊：\x05␊{？␘κφ～␑ｋQ%Ｊγτ7δ␋\x03\t：",
    " \t\x1dＭ\n9\x1b␊：\x05␊{？␘κφ～␑ｋQ％Ｊγτ7δ␋\x03\t：",
  ],
  [
    EncodeBackSlash | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \t\x03\r␌Ｒγ＂νeχ'β\x1b；πｊ'=ς\x1c|Ｙ␚␐7␘␁\t?",
    " \t\x03\r␌Ｒγ＂νeχ'β\x1b；πｊ'=ς\x1c|Ｙ␚␐7␘␁\t?",
  ],
  [
    EncodeDel | EncodeRightSpace | EncodeRightCrLfHtVt,
    " \tοβ\x1aｆ[＊\x1cGdＮ␑␞κ％ν）Ｈ~␖\x06θ/g>␡Ｄ\t]",
    " \tοβ\x1aｆ[＊\x1cGdＮ␑␞κ％ν）Ｈ~␖\x06θ/g>‛␡Ｄ\t]",
  ],
  [
    EncodeZero | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\t9Ｌ\x16ς］␟\x064\n␁＇␆ςωr\x1b\\ｖ＞-␂␒ηψ\x1cσ\t␡",
    ".\t9Ｌ\x16ς］␟\x064\n␁＇␆ςωr\x1b\\ｖ＞-␂␒ηψ\x1cσ\t␡",
  ],
  [
    EncodeSlash | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\t␝␜］υ?，\x14\r０wμ＄␃ｂ\x1b］ςν\x11＆d}S␙f\x18\tθ",
    ".\t␝␜］υ?，\x14\r０wμ＄␃ｂ\x1b］ςν\x11＆d}S␙f\x18\tθ",
  ],
  [
    EncodeSingleQuote | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\t｝ξMyk3eｔβπε４ｘψ\\％\x10\x13␔;＞＜\x14：␜␊\t－",
    ".\t｝ξMyk3eｔβπε４ｘψ\\％\x10\x13␔;＞＜\x14：␜␊\t－",
  ],
  [
    EncodeBackQuote | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\t␐！\x07λψ␔N ο\\P！ς/～\x17k\x02N␝κ！\t５ωｅ\t␅",
    ".\t␐！\x07λψ␔N ο\\P！ς/～\x17k\x02N␝κ！\t５ωｅ\t␅",
  ],
  [
    EncodeLtGt | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\tfＢ！＂;ψ;ε；｜κy＄\x1fηHＴ\\ｚ␛␅－\n\x1fZ3\tλ",
    ".\tfＢ！＂;ψ;ε；｜κy＄\x1fηHＴ\\ｚ␛␅－\n\x1fZ3\tλ",
  ],
  [
    EncodeSquareBracket | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\tｖ␁＿5;ｐＭα｛␙␕#wφ<;pζ＇␃φ␌jυ．j\t\x00",
    ".\tｖ␁＿5;ｐＭα｛␙␕#wφ<;pζ＇␃φ␌jυ．j\t␀",
  ],
  [
    EncodeSemicolon | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\t|］␂<ｎ\x1dςηｂＴςσH␏\x13vk␔＊ｒ␗ν\x14ψ｜ｌ\t\x11",
    ".\t|］␂<ｎ\x1dςηｂＴςσH␏\x13vk␔＊ｒ␗ν\x14ψ｜ｌ\t\x11",
  ],
  [
    EncodeExclamation | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\tE!␆[␡Ｒτ｀１λφφφ %p＇|ε5？，<\x05w］\tＷ",
    ".\tE！␆[␡Ｒτ｀１λφφφ %p＇|ε5？，<\x05w］\tＷ",
  ],
  [
    EncodeDollar | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\t\f\x10－y␕;␁ｗTＵ\x04␈\x07；～Ｖπλκyι\x1dL␆δ␙\t'",
    ".\t\f\x10－y␕;␁ｗTＵ\x04␈\x07；～Ｖπλκyι\x1dL␆δ␙\t'",
  ],
  [
    EncodeDoubleQuote | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\t>!７\x06τ\x01ξK｜\x12␒～|＝t␖ｊ␘θυU␇２l\x17］\tR",
    ".\t>!７\x06τ\x01ξK｜\x12␒～|＝t␖ｊ␘θυU␇２l\x17］\tR",
  ],
  [
    EncodeColon | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\t／ty～｜9κ\f%4：␡＝\x14σ％\x0fｍ␅\rφπ\x1c０／Ｗ\tλ",
    ".\t／ty～｜9κ\f%4‛：␡＝\x14σ％\x0fｍ␅\rφπ\x1c０／Ｗ\tλ",
  ],
  [
    EncodeQuestion | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\tα[FK|βＺ／␌-iκ％οRｅ␜␒ｃε\\]\x05\f＾２\tρ",
    ".\tα[FK|βＺ／␌-iκ％οRｅ␜␒ｃε\\]\x05\f＾２\tρ",
  ],
  [
    EncodeAsterisk | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\tαο／＠＾␊θψ\x19M\x1f\x152I␍SＷ\x19ｂο＼g␊κA␜\tＵ",
    ".\tαο／＠＾␊θψ\x19M\x1f\x152I␍SＷ\x19ｂο＼g␊κA␜\tＵ",
  ],
  [
    EncodePipe | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\tｂ␄＂%Tδ␊@βRＴ␞␌．Ｋ'RDρνβ\f＃Ｄ\n\x0e\t<",
    ".\tｂ␄＂%Tδ␊@βRＴ␞␌．Ｋ'RDρνβ\f＃Ｄ\n\x0e\t<",
  ],
  [
    EncodeHash | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\tＷ>τP＃Ｋ$I\x01\rςαν/\x12\t＃ｆ␖otＹ\uff00ｚν␉\t5",
    ".\tＷ>τP‛＃Ｋ$I\x01\rςαν/\x12\t‛＃ｆ␖otＹ\uff00ｚν␉\t5",
  ],
  [
    EncodePercent | EncodeRightPeriod | EncodeRightCrLfHtVt,
    ".\t１／␡＾\x1c\b－\n?fνπ␉｛φ<／Ｋψ\x03]\x1cμG｀d\t␍",
    ".\t１／␡＾\x1c\b－\n?fνπ␉｛φ<／Ｋψ\x03]\x1cμG｀d\t‛␍",
  ],
  [
    EncodeBackSlash | EncodeRightPeriod | EncodeRightCrLfHtVt,
    '.\t：＇χ␇_"␟υＡ\x17D␔ζβ\x1fn（ａＤMu␀ρ\n＋\x07\t\\',
    '.\t：＇χ␇_"␟υＡ\x17D␔ζβ\x1fn（ａＤMu‛␀ρ\n＋\x07\t＼',
  ],
  [
    EncodeDel | EncodeRightPeriod | EncodeRightCrLfHtVt,
    '.\t\fγｏG␓"τ$φp\x16７Fψｅυ／＂！\x1d1Ｒ{␍ε／\t␊',
    '.\t\fγｏG␓"τ$φp\x16７Fψｅυ／＂！\x1d1Ｒ{␍ε／\t‛␊',
  ],
];

const EDGE_EXAMPLES = [
  [EncodeLeftSpace, "  ", "␠ "],
  [EncodeLeftPeriod, "..", "．."],
  [EncodeLeftTilde, "~~", "～~"],
  [EncodeRightSpace, "  ", " ␠"],
  [EncodeRightPeriod, "..", ".．"],
  [EncodeLeftSpace | EncodeRightSpace, "  ", "␠␠"],
  [EncodeLeftSpace | EncodeRightSpace, "   ", "␠ ␠"],
  [EncodeRightPeriod | EncodeRightSpace, "a .", "a ．"],
];

test("encodeName and decodeName pass the cases of rclone for one flag", () => {
  assertCases("SINGLE", SINGLE);
});

test("encodeName and decodeName pass the cases of rclone for one edge", () => {
  assertCases("SINGLE_EDGE", SINGLE_EDGE);
  assertCases("EDGE_EXAMPLES", EDGE_EXAMPLES);
});

test("encodeName and decodeName pass the cases of rclone for two edges", () => {
  assertCases("DOUBLE_EDGE", DOUBLE_EDGE);
});
