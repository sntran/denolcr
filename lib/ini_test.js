import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { parse, stringify } from "./ini.js";

test("parse", () => {
  assert.deepEqual(parse(""), {});
  assert.deepEqual(
    parse(
      "top = 1\n[a]\ntype = s3\n  spaced key  =   a value  \nurl=https://x/?a=b\n" +
        "; a comment\n# a comment\n\n[b c]\nempty =\n",
    ),
    {
      top: "1",
      a: { type: "s3", "spaced key": "a value", url: "https://x/?a=b" },
      "b c": { empty: "" },
    },
  );
  // Two sections with the same name become one, as in rclone.
  assert.deepEqual(parse("[a]\nx = 1\n[a]\ny = 2\r\n"), {
    a: { x: "1", y: "2" },
  });
  assert.throws(() => parse("[a]\nno equal sign"), {
    name: "SyntaxError",
    message: 'INI: line 2 has no "=": no equal sign',
  });
});

test("parse does not change the prototype", () => {
  const config = parse("[__proto__]\npolluted = yes\n");
  assert.deepEqual(Object.keys(config), ["__proto__"]);
  assert.equal({}.polluted, undefined);
});

test("stringify writes the format of rclone", () => {
  const config = { a: { type: "s3", key: "v=1" }, b: { type: "local" } };
  assert.equal(
    stringify(config),
    "[a]\ntype = s3\nkey = v=1\n\n[b]\ntype = local",
  );
  assert.equal(stringify(config, { section: "" }), stringify(config));
  assert.equal(stringify(config.b, { section: "b" }), "[b]\ntype = local");
  assert.equal(stringify({ top: "1", a: { x: "2" } }), "top = 1\n\n[a]\nx = 2");
  assert.equal(stringify({ a: { x: undefined, y: null, z: 0 } }), "[a]\nz = 0");
  assert.equal(stringify({}), "");
});

test("parse reads what stringify writes", () => {
  const word = fc.stringMatching(/^[\w.][\w. -]*[\w.]$/);
  const value = fc.stringMatching(/^\S(.*\S)?$/).filter((v) =>
    !/[\r\n]/.test(v)
  );
  fc.assert(
    fc.property(
      fc.dictionary(word, fc.dictionary(word, value), { minKeys: 1 }),
      (config) => {
        assert.deepEqual(parse(stringify(config)), config);
      },
    ),
  );
});
