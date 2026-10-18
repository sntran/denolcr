import { test } from "node:test";
import assert from "node:assert/strict";

import { backends } from "../backend/main.js";
import { FLAGS, parseFlags } from "./flags.js";

/**
 * Backends with options, as the modules of `backend/main.js`. `loaded` has
 * the type of each backend that loads.
 */
function fakeBackends() {
  /** @type {string[]} */
  const loaded = [];
  const module = (type, options) => () => {
    loaded.push(type);
    return Promise.resolve({ options });
  };
  return {
    loaded,
    backends: {
      crypt: module("crypt", { string: ["remote", "password"] }),
      http: module("http", { boolean: ["no_head"], string: ["url"] }),
      local: module("local", undefined),
      s3: module("s3", {
        boolean: ["force_path_style"],
        default: { chunk_size: "5Mi" },
      }),
    },
  };
}

test("parseFlags reads the value of a flag after a space or after =", async () => {
  for (
    const args of [
      ["serve", "http", ".", "--addr", ":8080"],
      ["serve", "--addr=:8080", "http", "."],
      ["--addr", ":8080", "serve", "http", "."],
    ]
  ) {
    const { flags, positionals } = await parseFlags(args, {});
    assert.equal(flags.addr, ":8080", args.join(" "));
    assert.deepEqual(positionals, ["serve", "http", "."], args.join(" "));
  }
});

test("parseFlags reads a flag of a backend with the type of its option", async () => {
  const { backends, loaded } = fakeBackends();
  const { flags, positionals } = await parseFlags([
    "lsjson",
    "--crypt-password",
    "secret",
    "--http-no-head",
    "remote:",
    "--s3-force-path-style=false",
    "--s3-chunk-size",
    "8Mi",
  ], backends);
  assert.deepEqual(positionals, ["lsjson", "remote:"]);
  assert.equal(flags.crypt_password, "secret");
  assert.equal(flags["crypt-password"], "secret");
  assert.equal(flags.http_no_head, true);
  assert.equal(flags.s3_force_path_style, false);
  assert.equal(flags.s3_chunk_size, "8Mi");
  // Only the backends of the flags load.
  assert.deepEqual(loaded.toSorted(), ["crypt", "http", "s3"]);
});

test("parseFlags reads the boolean flags as rclone", async () => {
  const { flags, positionals } = await parseFlags([
    "lsf",
    "-R",
    "--dir-slash=false",
    "--files-only=1",
    "--no-clobber",
    "remote:",
  ], {});
  assert.deepEqual(positionals, ["lsf", "remote:"]);
  assert.equal(flags.recursive, true);
  assert.equal(flags.dir_slash, false);
  assert.equal(flags.files_only, true);
  // A flag with the name `no-...` is not the negation of a flag.
  assert.equal(flags.no_clobber, true);
  assert.equal(flags.clobber, undefined);
});

test("parseFlags gives the arguments after -- as they are", async () => {
  const { flags, positionals } = await parseFlags(
    ["cat", "--", "--addr"],
    {},
  );
  assert.deepEqual(positionals, ["cat", "--addr"]);
  assert.equal(flags.addr, undefined);
});

test("parseFlags gives the errors of rclone", async () => {
  const { backends } = fakeBackends();
  for (
    const [args, message] of [
      [["lsjson", "--nosuch", "x"], "unknown flag: --nosuch"],
      [["lsjson", "-x"], "unknown flag: -x"],
      // The local backend has no option: the root is not a flag.
      [["lsjson", "--local-root", "/"], "unknown flag: --local-root"],
      [["lsjson", "--crypt-nosuch", "x"], "unknown flag: --crypt-nosuch"],
      [["lsjson", "--max-depth"], "flag needs an argument: --max-depth"],
      [
        ["lsjson", "--dry-run=maybe"],
        'invalid argument "maybe" for "--dry-run" flag',
      ],
      [
        ["lsjson", "--dry-run=constructor"],
        'invalid argument "constructor" for "--dry-run" flag',
      ],
    ]
  ) {
    await assert.rejects(parseFlags(args, backends), { message }, `${args}`);
  }
});

test("parseFlags reads each option of each backend of rfetch as a flag", async () => {
  for (const [type, load] of Object.entries(backends)) {
    const { options } = await load();
    if (!options) continue;
    const booleans = options.boolean ?? [];
    const strings = [
      ...options.string ?? [],
      ...Object.keys(options.default ?? {}),
    ].filter((name) => !booleans.includes(name));
    for (const name of booleans) {
      const flag = `--${type}-${name.replaceAll("_", "-")}`;
      const { flags, positionals } = await parseFlags(
        ["lsjson", flag, "remote:"],
        backends,
      );
      assert.equal(flags[`${type}_${name}`], true, flag);
      assert.deepEqual(positionals, ["lsjson", "remote:"], flag);
    }
    for (const name of strings) {
      const flag = `--${type}-${name.replaceAll("_", "-")}`;
      const { flags, positionals } = await parseFlags(
        ["lsjson", flag, "value", "remote:"],
        backends,
      );
      assert.equal(flags[`${type}_${name}`], "value", flag);
      assert.deepEqual(positionals, ["lsjson", "remote:"], flag);
    }
  }
});

test("FLAGS has a type for each flag, and no short name two times", () => {
  const shorts = Object.values(FLAGS).map(({ short }) => short).filter(
    Boolean,
  );
  assert.equal(new Set(shorts).size, shorts.length);
  for (const [name, { type }] of Object.entries(FLAGS)) {
    assert.ok(type === "boolean" || type === "string", name);
  }
});
