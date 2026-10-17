import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import fc from "fast-check";

import { ConfigFile, parse, ParseStream, read, stringify } from "./ini.js";

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
    assert.deepEqual(parse("\uFEFF[a]\u0085\n\u00A0k = v\u3000\r\n"), {
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
          "[k6": "v]",
        },
      }),
      '[a]\n`k=1` = `  v  `\n`#k` = """a"`b"""\n"k`:" = """a`b"""\n' +
        '"""k`"=""" = `"""x`\nk5 = "q"\n[k6 = `v]`',
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

test("ParseStream gives an entry for each line with a section, a key or a comment", async () => {
  const entries = await Array.fromAsync(
    ReadableStream.from(["top = 1\n[a", "]\n# note\nk = v\n\n- = x", "\n[]"])
      .pipeThrough(new ParseStream()),
  );
  assert.deepEqual(entries, [
    { type: "key", section: "DEFAULT", line: 1, key: "top", value: "1" },
    { type: "section", section: "a", line: 2 },
    { type: "comment", section: "a", line: 3, text: "# note" },
    { type: "key", section: "a", line: 4, key: "k", value: "v" },
    { type: "key", section: "a", line: 6, key: "#1", value: "x", auto: true },
    { type: "section", section: "", line: 7 },
  ]);
});

describe("ConfigFile", () => {
  const text = [
    "# The remotes of the person.",
    "",
    "# The disk at work.",
    "[work]",
    "type: drive",
    "# A note on the token.",
    "token = {}",
    "",
    "[home]",
    "type = local",
    "# The last comment.",
    "",
  ].join("\n");

  test("keeps the text when nothing changes", () => {
    const file = new ConfigFile(text);
    assert.equal(file.toString(), text);
    assert.deepEqual(file.config, parse(text));
  });

  test("changes only the value of a key, and keeps the comments", () => {
    const file = new ConfigFile(text);
    file.update("work", { type: "s3", token: "{}" });
    assert.equal(file.toString(), text.replace("type: drive", "type: s3"));
  });

  test("puts a new key after the last key of the section", () => {
    const file = new ConfigFile(text);
    file.update("home", { "a b": "  x  " });
    assert.equal(
      file.toString(),
      text.replace("type = local", "type = local\na b = `  x  `"),
    );
  });

  test("puts a new section at the end, after an empty line", () => {
    const file = new ConfigFile(text);
    file.update("new", { type: "memory" });
    assert.equal(file.toString(), `${text}\n[new]\ntype = memory\n`);
    assert.equal(
      new ConfigFile("[a]").toString(),
      "[a]",
    );
    const empty = new ConfigFile("");
    empty.set("a", { type: "local" });
    assert.equal(empty.toString(), "[a]\ntype = local\n");
  });

  test("removes a key with its comment, and keeps the other comments", () => {
    const file = new ConfigFile(text);
    file.update("work", { token: null });
    assert.equal(
      file.toString(),
      text.replace("# A note on the token.\ntoken = {}\n", ""),
    );

    const again = new ConfigFile(text);
    again.set("work", { type: "drive" });
    assert.equal(again.toString(), file.toString());
  });

  test("removes a section with its comments, but not the other comments", () => {
    const file = new ConfigFile(text);
    file.delete("work");
    assert.equal(
      file.toString(),
      "# The remotes of the person.\n\n[home]\ntype = local\n# The last comment.\n",
    );
    // The last comment has an empty line below it, thus it stays.
    file.delete("home");
    assert.equal(
      file.toString(),
      "# The remotes of the person.\n\n# The last comment.\n",
    );
  });

  test("keeps the numbers of the keys -", () => {
    const file = new ConfigFile("[a]\n- = x\n- = y\n- = z");
    file.update("a", { "#1": null, "#3": "Z" });
    assert.equal(file.toString(), "[a]\n`#2` = y\n`#3` = Z");
    assert.deepEqual(file.config, { a: { "#2": "y", "#3": "Z" } });
  });

  test("keeps the place of DEFAULT", () => {
    const top = new ConfigFile("x = 1\n[a]");
    top.set("DEFAULT", { y: "2" });
    assert.equal(top.toString(), "[DEFAULT]\ny = 2\n[a]");

    const empty = new ConfigFile("[]\n[a]");
    empty.update("DEFAULT", { y: "2" });
    assert.equal(empty.toString(), "[DEFAULT]\ny = 2\n[a]");
  });

  test("keeps the ends of lines and the byte order mark", () => {
    const file = new ConfigFile("\uFEFF[a]\r\nk = v\r\n");
    file.update("a", { k: "w", n: "1" });
    assert.equal(file.toString(), "\uFEFF[a]\r\nk = w\r\nn = 1\r\n");
  });

  test("does not change for what rclone cannot read the same", () => {
    const file = new ConfigFile(text);
    for (
      const change of [
        () => file.update("work", { type: "line 1\nline 2" }),
        () => file.update("work", { "-": "x" }),
        () => file.set(" bad name", {}),
      ]
    ) {
      assert.throws(change, TypeError);
      assert.equal(file.toString(), text);
    }
  });
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
  "\u00A0",
  "\u3000",
  "\uFEFF",
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
  { weight: 1, arbitrary: text.map((value) => `- = ${value}`) },
  { weight: 1, arbitrary: text.map((comment) => `# ${comment}`) },
  { weight: 1, arbitrary: text },
);

/** The text of a configuration file. */
const file = fc.tuple(
  fc.constantFrom("", "\uFEFF"),
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

/**
 * A file that parse reads, and changes for it: the names and the keys are
 * often names and keys of the file.
 */
const edited = file.chain((source) => {
  let config;
  try {
    config = parse(source);
  } catch {
    return fc.constant(null);
  }
  const names = Object.keys(config);
  const keys = [...new Set(Object.values(config).flatMap(Object.keys))];
  const name = fc.oneof(
    ...(names.length ? [fc.constantFrom(...names)] : []),
    fc.constant("DEFAULT"),
    text,
  );
  const changes = fc.uniqueArray(
    fc.tuple(
      keys.length ? fc.oneof(fc.constantFrom(...keys), key) : key,
      fc.option(text, { nil: null, freq: 3 }),
    ),
    { selector: ([key]) => key, maxLength: 4 },
  ).map((entries) => Object.fromEntries(entries));
  const change = fc.oneof(
    fc.record({ type: fc.constantFrom("update", "set"), name, keys: changes }),
    fc.record({ type: fc.constant("delete"), name }),
  );
  return fc.record({
    text: fc.constant(source),
    changes: fc.array(change, { maxLength: 4 }),
  });
}).filter((value) => value !== null);

/**
 * Makes a change in a ConfigFile, and in a model of the configuration with
 * maps. A change that throws a TypeError must not change the file, and does
 * not change the model.
 * @param {ConfigFile} file
 * @param {Map<string, Map<string, string>>} model
 * @param {{ type: string, name: string, keys?: Record<string, ?string> }} change
 */
function change(file, model, { type, name, keys }) {
  const before = file.toString();
  try {
    if (type === "delete") file.delete(name);
    else file[type](name, keys);
  } catch (error) {
    assert.ok(error instanceof TypeError, error);
    assert.equal(
      file.toString(),
      before,
      "a change that throws changes nothing",
    );
    return false;
  }

  if (type === "delete") {
    model.delete(name);
    return true;
  }
  const old = model.get(name) ?? new Map();
  const next = new Map(old);
  if (type === "set") {
    for (const key of old.keys()) {
      if ((Object.hasOwn(keys, key) ? keys[key] : null) === null) {
        next.delete(key);
      }
    }
  }
  for (const [key, value] of Object.entries(keys)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  model.set(name, next);
  return true;
}

/** @param {Record<string, Record<string, string>>} config */
function toModel(config) {
  return new Map(
    Object.entries(config).map((
      [name, keys],
    ) => [name, new Map(Object.entries(keys))]),
  );
}

/** @param {Map<string, Map<string, string>>} model */
function fromModel(model) {
  return Object.fromEntries(
    [...model].map(([name, keys]) => [name, Object.fromEntries(keys)]),
  );
}

/**
 * The entries of each line of a text, by the number of the line.
 * @param {string} text
 */
async function entriesOf(text) {
  const entries = await Array.fromAsync(
    ReadableStream.from([text]).pipeThrough(new ParseStream()),
  );
  return new Map(entries.map((entry) => [entry.line, entry]));
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

  test("ConfigFile keeps the text of each file that parse reads", () => {
    fc.assert(
      fc.property(file, (text) => {
        let config;
        try {
          config = parse(text);
        } catch {
          return;
        }
        const configFile = new ConfigFile(text);
        assert.equal(configFile.toString(), text);
        assert.deepEqual(ordered(configFile.config), ordered(config));
      }),
      { numRuns: 1000 },
    );
  });

  test("ConfigFile changes the configuration as a model of maps", () => {
    fc.assert(
      fc.property(edited, ({ text, changes }) => {
        const configFile = new ConfigFile(text);
        const model = toModel(configFile.config);
        for (const item of changes) {
          change(configFile, model, item);
          const expected = ordered(fromModel(model));
          assert.deepEqual(ordered(configFile.config), expected);
          assert.deepEqual(ordered(parse(configFile.toString())), expected);
        }
      }),
      { numRuns: 1000 },
    );
  });

  test("ConfigFile does not throw for the changes that rclone makes", () => {
    fc.assert(
      fc.property(
        rcloneConfig,
        fc.array(fc.tuple(fc.boolean(), fc.boolean()), { maxLength: 4 }),
        (config, steps) => {
          const configFile = new ConfigFile();
          const model = new Map();
          const names = Object.keys(config);
          for (const [index, [set, remove]] of steps.entries()) {
            const name = names[index % names.length];
            if (name === undefined) break;
            const item = remove
              ? { type: "delete", name }
              : { type: set ? "set" : "update", name, keys: config[name] };
            assert.ok(change(configFile, model, item), "no TypeError");
          }
          assert.deepEqual(
            ordered(configFile.config),
            ordered(fromModel(model)),
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  test("ConfigFile removes only the comments directly above a line that goes away", async () => {
    await fc.assert(
      fc.asyncProperty(
        edited.filter(({ changes }) => changes.length > 0),
        async ({ text, changes: [item] }) => {
          const before = await entriesOf(text);
          const configFile = new ConfigFile(text);
          const changed = change(configFile, toModel(configFile.config), item);

          /** Tells if the line of an entry goes away with the change. */
          const goes = (entry) => {
            if (!changed || entry.type === "comment") return false;
            const section = entry.section || "DEFAULT";
            if (item.type === "delete") return section === item.name;
            if (entry.type !== "key" || section !== item.name) return false;
            if (entry.key === "" || entry.key === " ") return false;
            const value = Object.hasOwn(item.keys, entry.key)
              ? item.keys[entry.key]
              : undefined;
            return value === null ||
              (item.type === "set" && value === undefined);
          };

          const lines = text.split("\n").length;
          const expected = [];
          for (const entry of before.values()) {
            if (entry.type !== "comment") continue;
            // The comment is of the first line below it that is not a
            // comment, when that line is not empty.
            let below = entry.line + 1;
            while (before.get(below)?.type === "comment") below++;
            const target = below <= lines ? before.get(below) : undefined;
            if (!target || !goes(target)) expected.push(entry.text);
          }

          const after = await entriesOf(configFile.toString());
          const comments = [...after.values()]
            .filter(({ type }) => type === "comment")
            .map(({ text }) => text);
          assert.deepEqual(comments, expected);
        },
      ),
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
  test("rclone reads the file that ConfigFile changes", () => {
    fc.assert(
      fc.property(edited, ({ text, changes }) => {
        const configFile = new ConfigFile(text);
        const model = toModel(configFile.config);
        for (const item of changes) change(configFile, model, item);
        assert.deepEqual(
          rclone(configFile.toString()).config,
          fromModel(model),
        );
      }),
      { numRuns: 50 },
    );
  });
});
