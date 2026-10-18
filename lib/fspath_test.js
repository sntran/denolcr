import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { Errors, isConfigName, parse } from "./fspath.js";

/**
 * The cases of TestParse of rclone 1.75.1 (fs/fspath/path_test.go), with
 * no case for Windows only: a path, and its parts or its error.
 */
const CASES = [
  ["", Errors.CANT_BE_EMPTY],
  [":", Errors.CONFIG_NAME],
  ["::", Errors.CONFIG_NAME_EMPTY],
  [":/:", Errors.INVALID_CHARACTERS],
  ["/:", { name: "", configString: "", path: "/:" }],
  ["\\backslash:", { name: "", configString: "", path: "\\backslash:" }],
  ["/slash:", { name: "", configString: "", path: "/slash:" }],
  ["with\\backslash:", {
    name: "",
    configString: "",
    path: "with\\backslash:",
  }],
  ["with/slash:", { name: "", configString: "", path: "with/slash:" }],
  ["/path/to/file", { name: "", configString: "", path: "/path/to/file" }],
  ["/path:/to/file", { name: "", configString: "", path: "/path:/to/file" }],
  ["./path:/to/file", { name: "", configString: "", path: "./path:/to/file" }],
  ["./:colon.txt", { name: "", configString: "", path: "./:colon.txt" }],
  ["path/to/file", { name: "", configString: "", path: "path/to/file" }],
  [".:", { name: ".", configString: ".", path: "" }],
  ["..:", { name: "..", configString: "..", path: "" }],
  [".:colon.txt", { name: ".", configString: ".", path: "colon.txt" }],
  ["remote:path/to/file", {
    name: "remote",
    configString: "remote",
    path: "path/to/file",
  }],
  ["rem*ote:path/to/file", Errors.INVALID_CHARACTERS],
  ["remote:/path/to/file", {
    name: "remote",
    configString: "remote",
    path: "/path/to/file",
  }],
  ["rem.ote:/path/to/file", {
    name: "rem.ote",
    configString: "rem.ote",
    path: "/path/to/file",
  }],
  ["rem ote:/path/to/file", {
    name: "rem ote",
    configString: "rem ote",
    path: "/path/to/file",
  }],
  ["remote :/path/to/file", Errors.INVALID_CHARACTERS],
  [" remote:/path/to/file", Errors.INVALID_CHARACTERS],
  [" remote :/path/to/file", Errors.INVALID_CHARACTERS],
  ["rem#ote:/path/to/file", Errors.INVALID_CHARACTERS],
  [":backend:/path/to/file", {
    name: ":backend",
    configString: ":backend",
    path: "/path/to/file",
  }],
  [":back.end:/path/to/file", {
    name: ":back.end",
    configString: ":back.end",
    path: "/path/to/file",
  }],
  [":bac*kend:/path/to/file", Errors.INVALID_CHARACTERS],
  ["C:\\path\\to\\file", {
    name: "C",
    configString: "C",
    path: "\\path\\to\\file",
  }],
  ["\\path\\to\\file", {
    name: "",
    configString: "",
    path: "\\path\\to\\file",
  }],
  [".", { name: "", configString: "", path: "." }],
  ["..", { name: "", configString: "", path: ".." }],
  ["remote:\\path\\to\\file", {
    name: "remote",
    configString: "remote",
    path: "\\path\\to\\file",
  }],
  ["D:/path/to/file", { name: "D", configString: "D", path: "/path/to/file" }],
  [":backend,param1:/path/to/file", {
    name: ":backend",
    configString: ":backend,param1",
    path: "/path/to/file",
    config: { param1: "true" },
  }],
  [":backend,param1=value:/path/to/file", {
    name: ":backend",
    configString: ":backend,param1=value",
    path: "/path/to/file",
    config: { param1: "value" },
  }],
  [":backend,param1=value1,param2,param3=value3:/path/to/file", {
    name: ":backend",
    configString: ":backend,param1=value1,param2,param3=value3",
    path: "/path/to/file",
    config: { param1: "value1", param2: "true", param3: "value3" },
  }],
  [":backend,param1=value1,param2=\"value2\",param3='value3':/path/to/file", {
    name: ":backend",
    configString: ":backend,param1=value1,param2=\"value2\",param3='value3'",
    path: "/path/to/file",
    config: { param1: "value1", param2: "value2", param3: "value3" },
  }],
  [":backend,param-1=value:/path/to/file", Errors.BAD_CONFIG_PARAM],
  [':backend,param1="value"x:/path/to/file', Errors.AFTER_QUOTE],
  [":backend,", Errors.PARAM],
  [":backend,param=value", Errors.VALUE],
  [":backend,param=\"value'", Errors.QUOTED_VALUE],
  [':backend,param1="value"', Errors.AFTER_QUOTE],
  [":backend,=value:", Errors.EMPTY_CONFIG_PARAM],
  [":backend,:", Errors.EMPTY_CONFIG_PARAM],
  [":backend,,:", Errors.EMPTY_CONFIG_PARAM],
  [":backend,param=:path", {
    name: ":backend",
    configString: ":backend,param=",
    path: "path",
    config: { param: "" },
  }],
  [':backend,param="with""quote":path', {
    name: ":backend",
    configString: ':backend,param="with""quote"',
    path: "path",
    config: { param: 'with"quote' },
  }],
  [":backend,param='''''':", {
    name: ":backend",
    configString: ":backend,param=''''''",
    path: "",
    config: { param: "''" },
  }],
  [":backend,param=''bad'':", Errors.AFTER_QUOTE],
];

test("parse reads the paths of rclone (TestParse)", () => {
  for (const [text, expected] of CASES) {
    const what = JSON.stringify(text);
    if (typeof expected === "string") {
      assert.throws(() => parse(text), {
        name: "SyntaxError",
        message: expected,
      }, what);
      continue;
    }
    const { config = {}, ...parts } = expected;
    const parsed = parse(text);
    assert.deepEqual(
      { ...parsed, config: { ...parsed.config } },
      { ...parts, config },
      what,
    );
  }
});

test("isConfigName accepts the names of rclone (TestCheckConfigName)", () => {
  for (
    const name of [
      "remote",
      "REMOTE",
      "r-emote-",
      "_rem_ote_",
      ".",
      "..",
      ".r.e.m.o.t.e.",
      "rem ote",
      "user@example.com",
      "user+junkmail@example.com",
      "blåbær",
      "chữ Quốc ngữ",
    ]
  ) {
    assert.ok(isConfigName(name), name);
  }
  for (
    const name of [
      "",
      ":remote:",
      "remote:",
      "rem:ote",
      "rem/ote",
      "rem\\ote",
      "[remote",
      "*",
      "-remote",
      "---rem:::ote???",
      "remote ",
      " remote",
      " remote ",
    ]
  ) {
    assert.ok(!isConfigName(name), name);
  }
});

test("parse gives back the options of a connection string", () => {
  const param = fc.stringMatching(/^[\w.]{1,8}$/);
  const value = fc.string({ maxLength: 12 });
  fc.assert(
    fc.property(
      fc.dictionary(param, value, { maxKeys: 4 }),
      fc.constantFrom("'", '"'),
      fc.string({ maxLength: 12 }),
      (config, quote, path) => {
        const options = Object.entries(config).map(([name, value]) =>
          `,${name}=${quote}${value.replaceAll(quote, quote + quote)}${quote}`
        );
        const parsed = parse(`:backend${options.join("")}:${path}`);
        assert.equal(parsed.name, ":backend");
        assert.equal(parsed.path, path);
        assert.deepEqual({ ...parsed.config }, { ...config });
      },
    ),
  );
});
