import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import fc from "fast-check";

import { parse, ParseStream, read, stringify } from "./ini.js";

describe("parse", () => {
  test("reads sections and keys", () => {
    assert.deepEqual(parse(""), {});
    assert.deepEqual(
      parse(
        "[a]\ntype = s3\n  spaced key  =   a value  \nurl=https://x/?a=b\n" +
          "; a comment\n# a comment\n\n[b c]\nempty =\n",
      ),
      {
        a: { type: "s3", "spaced key": "a value", url: "https://x/?a=b" },
        "b c": { empty: "" },
      },
    );
  });

  test("puts the keys before the first section in DEFAULT", () => {
    assert.deepEqual(parse("top = 1\n[a]\nx = 2"), {
      DEFAULT: { top: "1" },
      a: { x: "2" },
    });
    assert.deepEqual(parse("[DEFAULT]\ntop = 1\n[]"), {
      DEFAULT: { top: "1" },
    });
  });

  test("makes one section of two sections with the same name", () => {
    assert.deepEqual(parse("[a]\nx = 1\n[b]\n[a]\ny = 2\r\nx = 3"), {
      a: { x: "3", y: "2" },
      b: {},
    });
  });

  test('ends a key at the first "=" or ":"', () => {
    assert.deepEqual(parse("[a]\nk1: v=1\nk2 = v:2\nk3:"), {
      a: { k1: "v=1", k2: "v:2", k3: "" },
    });
  });

  test("reads keys and values in quotes", () => {
    assert.deepEqual(
      parse(
        '[a]\n`k=1` = `  v  `\n"k`2" = """a"`b"""\n' +
          '"""k"`3""" = `a`b` rest\nk4 = "q"\nk5 = """é\n',
      ),
      {
        a: {
          "k=1": "  v  ",
          "k`2": 'a"`b',
          'k"`3': "a`b",
          k4: '"q"',
          k5: '"""é',
        },
      },
    );
  });

  test("gives numbers to the keys -", () => {
    assert.deepEqual(parse("[a]\n- = x\n- = y\n[b]\n- = z"), {
      a: { "#1": "x", "#2": "y" },
      b: { "#1": "z" },
    });
  });

  test("ignores the empty key and the key ' '", () => {
    assert.deepEqual(parse('[a]\n"" = x\n" " = y\nk = v'), { a: { k: "v" } });
  });

  test("removes the white space of Go and the byte order mark", () => {
    assert.deepEqual(parse("﻿[a]\u0085\n k = v　\r\n"), {
      a: { k: "v" },
    });
  });

  test("gives an error with the line number and no text of the line", () => {
    for (
      const [text, message] of [
        ["[a]\nno equal sign", 'INI: line 2 has no "=" or ":" after a key.'],
        ["[a]\n= value", 'INI: line 2 has no "=" or ":" after a key.'],
        [
          '[a]\n"key = value',
          "INI: line 2 has a key with no quote at the end.",
        ],
        [
          "[a]\nk = `secret",
          "INI: line 2 has a value with no quote at the end.",
        ],
        ['[a]\nk = """€', "INI: line 2 has a value with no quote at the end."],
        ["[]\nk = v", "INI: line 2 has a key in a section with no name."],
      ]
    ) {
      assert.throws(() => parse(text), { name: "SyntaxError", message });
    }
  });

  test("does not change the prototype", () => {
    const config = parse("[__proto__]\npolluted = yes\n");
    assert.deepEqual(Object.keys(config), ["__proto__"]);
    assert.equal({}.polluted, undefined);
  });
});

describe("stringify", () => {
  test("writes the format of rclone", () => {
    const config = { a: { type: "s3", key: "v=1" }, b: { type: "local" } };
    assert.equal(
      stringify(config),
      "[a]\ntype = s3\nkey = v=1\n\n[b]\ntype = local",
    );
    assert.equal(stringify(config, { section: "" }), stringify(config));
    assert.equal(stringify(config.b, { section: "b" }), "[b]\ntype = local");
    assert.equal(
      stringify({ DEFAULT: { top: "1" }, a: { x: "2" } }),
      "top = 1\n\n[a]\nx = 2",
    );
    assert.equal(
      stringify({ a: {}, DEFAULT: { top: "1" } }),
      "[a]\n\n[DEFAULT]\ntop = 1",
    );
    assert.equal(
      stringify({ a: { x: undefined, y: null, z: 0 } }),
      "[a]\nz = 0",
    );
    assert.equal(stringify({}), "");
  });

  test("puts in quotes what rclone does not read the same with no quotes", () => {
    assert.equal(
      stringify({
        a: {
          "k=1": "  v  ",
          "#k": 'a"`b',
          "k`:": "a`b",
          'k`"=': '"""x',
          "k5": '"q"',
        },
      }),
      '[a]\n`k=1` = `  v  `\n`#k` = """a"`b"""\n"k`:" = """a`b"""\n' +
        '"""k`"=""" = `"""x`\nk5 = "q"',
    );
  });

  test("throws for what rclone cannot read the same", () => {
    for (
      const config of [
        { "": { k: "v" } },
        { " a": {} },
        { "a\nb": {} },
        { a: { "": "v" } },
        { a: { " ": "v" } },
        { a: { "-": "v" } },
        { a: { "k\n": "v" } },
        { a: { 'k`="': "v" } },
        { a: { k: "line 1\nline 2" } },
        { a: "not a section" },
      ]
    ) {
      assert.throws(() => stringify(config), TypeError);
    }
  });
});

test("ParseStream gives an entry for each section and each key", async () => {
  const entries = await Array.fromAsync(
    ReadableStream.from(["top = 1\n[a", "]\nk = v\n- = x", "\n[b]"])
      .pipeThrough(new ParseStream()),
  );
  assert.deepEqual(entries, [
    { section: "DEFAULT", key: "top", value: "1" },
    { section: "a" },
    { section: "a", key: "k", value: "v" },
    { section: "a", key: "#1", value: "x" },
    { section: "b" },
  ]);
});

// The generators for the properties.

/** Pieces of text with the characters that have a meaning for goconfig. */
const PIECES = [
  "=",
  ":",
  "#",
  ";",
  "[",
  "]",
  '"',
  '"""',
  "`",
  "-",
  " ",
  "\t",
  "\r",
  "\u0085",
  " ",
  "　",
  "﻿",
  "é",
  "€",
  "😀",
  "DEFAULT",
  "a",
  "b",
  "type",
  "s3:bucket",
];

/** A text with no line break. */
const text = fc.array(
  fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...PIECES) },
    {
      weight: 1,
      arbitrary: fc.fullUnicodeString({ maxLength: 4 })
        .map((text) => text.replaceAll("\n", "")),
    },
  ),
  { maxLength: 6 },
).map((pieces) => pieces.join(""));

const quote = fc.constantFrom("`", '"', '"""');

/** A key: often a name of an option, but sometimes any text. */
const key = fc.oneof(
  { weight: 3, arbitrary: fc.stringMatching(/^[a-z_][a-z0-9_]{0,8}$/) },
  { weight: 2, arbitrary: text },
);

/** A line of a configuration file, often a line that goconfig accepts. */
const line = fc.oneof(
  { weight: 2, arbitrary: text.map((name) => `[${name}]`) },
  {
    weight: 4,
    arbitrary: fc.tuple(key, fc.constantFrom(" = ", "=", ": ", " : "), text)
      .map(([key, delimiter, value]) => `${key}${delimiter}${value}`),
  },
  {
    weight: 2,
    arbitrary: fc.tuple(quote, key, quote, text)
      .map(([q1, key, q2, value]) => `${q1}${key}${q1} = ${q2}${value}${q2}`),
  },
  {
    weight: 1,
    arbitrary: fc.tuple(key, quote, text)
      .map(([key, q, value]) => `${key} = ${q}${value}`),
  },
  { weight: 1, arbitrary: text.map((comment) => `# ${comment}`) },
  { weight: 1, arbitrary: text },
);

/** The text of a configuration file. */
const file = fc.tuple(
  fc.constantFrom("", "﻿"),
  fc.array(fc.tuple(line, fc.constantFrom("\n", "\r\n")), { maxLength: 10 }),
).map(([start, lines]) =>
  start + lines.map(([line, end]) => line + end).join("")
);

/**
 * A configuration from the given names, keys and values.
 * @param {fc.Arbitrary<string>} name
 * @param {fc.Arbitrary<string>} key
 * @param {fc.Arbitrary<string>} value
 */
function configOf(name, key, value) {
  const keys = fc.uniqueArray(fc.tuple(key, value), {
    selector: ([key]) => key,
    maxLength: 5,
  });
  return fc.uniqueArray(fc.tuple(name, keys), {
    selector: ([name]) => name,
    maxLength: 4,
  }).map((sections) =>
    Object.fromEntries(
      sections.map(([name, keys]) => [name, Object.fromEntries(keys)]),
    )
  );
}

/** A configuration from texts with the characters that have a meaning. */
const anyConfig = configOf(text, text, text);

/**
 * A configuration as rclone makes it: the names of remotes as
 * `fspath.CheckConfigName` accepts them, the names of options, and values of
 * all characters but a line break.
 */
const rcloneConfig = configOf(
  fc.stringMatching(/^[\w.+@é世]+(?:[ -]+[\w.+@é世-]+)*$/),
  fc.stringMatching(/^[a-z][a-z0-9_]*$/),
  fc.oneof(
    text,
    fc.fullUnicodeString().map((text) => text.replaceAll("\n", "")),
  ),
);

/**
 * The sections and the keys in their order, for a comparison that checks
 * the order too.
 * @param {Record<string, Record<string, string>>} config
 */
function ordered(config) {
  return Object.entries(config).map(([name, keys]) => [
    name,
    Object.entries(keys),
  ]);
}

/**
 * Gives the result of a function, or the message of its SyntaxError.
 * @param {() => any} read
 */
async function outcome(read) {
  try {
    return { config: ordered(await read()) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { error: error.message };
  }
}

describe("properties", () => {
  test("parse reads what stringify writes, or stringify throws", () => {
    fc.assert(
      fc.property(anyConfig, (config) => {
        let text;
        try {
          text = stringify(config);
        } catch (error) {
          assert.ok(error instanceof TypeError, error);
          return;
        }
        assert.deepEqual(ordered(parse(text)), ordered(config));
      }),
      { numRuns: 1000 },
    );
  });

  test("stringify writes each configuration that rclone makes", () => {
    fc.assert(
      fc.property(rcloneConfig, (config) => {
        assert.deepEqual(ordered(parse(stringify(config))), ordered(config));
      }),
      { numRuns: 500 },
    );
  });

  test("stringify writes each configuration that parse reads", () => {
    fc.assert(
      fc.property(file, (text) => {
        let config;
        try {
          config = parse(text);
        } catch (error) {
          assert.ok(error instanceof SyntaxError, error);
          return;
        }
        assert.deepEqual(ordered(parse(stringify(config))), ordered(config));
      }),
      { numRuns: 1000 },
    );
  });

  test("read gives the result of parse, for each split of the text", async () => {
    await fc.assert(
      fc.asyncProperty(
        file,
        fc.array(fc.nat(), { maxLength: 6 }),
        async (text, cuts) => {
          const points = [
            ...new Set(cuts.map((cut) => cut % (text.length + 1))),
          ]
            .sort((a, b) => a - b);
          const chunks = [];
          let start = 0;
          for (const point of points) {
            chunks.push(text.slice(start, point));
            start = point;
          }
          chunks.push(text.slice(start));

          assert.deepEqual(
            await outcome(() => read(ReadableStream.from(chunks))),
            await outcome(() => parse(text)),
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});

// The tests against rclone, which uses goconfig. RCLONE is the path of rclone,
// or "rclone" in the PATH.
const RCLONE = process.env.RCLONE || "rclone";
const hasRclone = spawnSync(RCLONE, ["version"]).status === 0;

describe("the same as rclone", {
  skip: !hasRclone && "rclone is not installed. Set RCLONE to its path.",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "rfetch-ini-"));
  const path = join(folder, "rclone.conf");
  after(() => rmSync(folder, { recursive: true, force: true }));

  /**
   * Gives the configuration that rclone reads from the text, or the error of
   * rclone.
   * @param {string} text
   */
  function rclone(text) {
    writeFileSync(path, text);
    const { status, stdout, stderr } = spawnSync(
      RCLONE,
      ["--config", path, "config", "dump"],
      // No RCLONE_* variable of this environment changes the result.
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: folder } },
    );
    return status === 0 ? { config: JSON.parse(stdout) } : { error: stderr };
  }

  test("parse reads each file as rclone reads it", () => {
    fc.assert(
      fc.property(file, (text) => {
        const expected = rclone(text);
        if (expected.error) {
          assert.match(expected.error, /could not parse line|empty section/);
          assert.throws(() => parse(text), SyntaxError);
        } else {
          // The JSON of rclone has the keys in the order of the alphabet.
          assert.deepEqual(parse(text), expected.config);
        }
      }),
      { numRuns: 100 },
    );
  });

  test("parse reads each line as rclone reads it", () => {
    fc.assert(
      fc.property(line, (line) => {
        const text = `[a]\n${line}\n`;
        const expected = rclone(text);
        if (expected.error) {
          assert.throws(() => parse(text), SyntaxError);
        } else {
          assert.deepEqual(parse(text), expected.config);
        }
      }),
      { numRuns: 100 },
    );
  });

  test("rclone reads what stringify writes", () => {
    fc.assert(
      fc.property(fc.oneof(anyConfig, rcloneConfig), (config) => {
        let text;
        try {
          text = stringify(config);
        } catch {
          return;
        }
        assert.deepEqual(rclone(text).config, config);
      }),
      { numRuns: 100 },
    );
  });
});
