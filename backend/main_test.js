/**
 * The tests of the registry of the backends, and of the rule of the
 * workspaces: a backend or a package imports only `node:` modules, the
 * packages of its `package.json`, and the files in its folder. Thus each one
 * is standalone, and can be a Worker of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { backends, load } from "./main.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The folders of the workspaces, for example `lib` and `backend/crypt`. */
const WORKSPACES = JSON.parse(readFileSync(join(ROOT, "package.json")))
  .workspaces.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return readdirSync(join(ROOT, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`)
      .filter((folder) => existsSync(join(ROOT, folder, "package.json")));
  });

/**
 * The files of a test or a bench. They can import the devDependencies, and
 * `mod.js` of rfetch: it sets the global `fetch` that reads the paths of
 * remotes, for the tests of a backend on top of other remotes.
 * @param {string} file
 */
function isTest(file) {
  return /(_test|_bench)\.js$|^testing\.js$/.test(file.split(sep).at(-1));
}

/** @param {string} folder @returns {string[]} The JavaScript files. */
function filesOf(folder) {
  return readdirSync(folder, { recursive: true })
    .filter((file) => file.endsWith(".js"))
    .filter((file) => !file.split(sep).includes("node_modules"));
}

/** @param {string} source @returns {string[]} The specifiers of imports. */
function importsOf(source) {
  const pattern =
    /\bfrom\s+"([^"]+)"|\bimport\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/g;
  return [...source.matchAll(pattern)].map((match) =>
    match[1] ?? match[2] ?? match[3]
  );
}

/** @param {string} specifier For example `@rfetch/lib/listing`. */
function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

test("each backend is in the registry, with its package name", () => {
  const folders = WORKSPACES.filter((folder) => folder.startsWith("backend/"))
    .map((folder) => folder.slice("backend/".length));
  assert.deepEqual(Object.keys(backends).sort(), folders.sort());
  for (const name of folders) {
    const { name: packageName } = JSON.parse(
      readFileSync(join(ROOT, "backend", name, "package.json")),
    );
    assert.equal(packageName, `@rfetch/${name}`);
  }
});

test("load gives each backend, and nothing for other names", async () => {
  for (const type of Object.keys(backends)) {
    const backend = await load(type);
    assert.equal(typeof backend?.fetch, "function", type);
  }
  for (const type of ["lib", "testing", "constructor", "__proto__", ""]) {
    assert.equal(await load(type), undefined, type);
  }
});

test("each workspace imports only node:, its packages, and its files", () => {
  for (const folder of WORKSPACES) {
    const path = join(ROOT, folder);
    const { dependencies = {}, devDependencies = {}, imports = {} } = JSON
      .parse(readFileSync(join(path, "package.json")));
    for (const file of filesOf(path)) {
      const source = readFileSync(join(path, file), "utf8");
      for (const specifier of importsOf(source)) {
        const where = `${folder}/${file}: ${specifier}`;
        if (specifier.startsWith("node:")) continue;
        if (specifier.startsWith(".")) {
          const target = relative(
            path,
            resolve(path, dirname(file), specifier),
          );
          const isHost = isTest(file) &&
            resolve(path, dirname(file), specifier) ===
              join(ROOT, "mod.js");
          assert.ok(
            isHost || !target.startsWith(".."),
            `${where} is out of the folder`,
          );
          continue;
        }
        if (specifier.startsWith("#")) {
          // A file of the folder, from the field `imports` of package.json.
          assert.ok(
            Object.hasOwn(imports, specifier),
            `${where} is not in imports`,
          );
          const targets = JSON.stringify(imports[specifier]).match(
            /"\.[^"]*"/g,
          );
          for (const target of targets ?? []) {
            const inside = relative(path, resolve(path, JSON.parse(target)));
            assert.ok(
              !inside.startsWith(".."),
              `${where} is out of the folder`,
            );
          }
          continue;
        }
        const name = packageOf(specifier);
        assert.ok(
          Object.hasOwn(dependencies, name) ||
            (isTest(file) && Object.hasOwn(devDependencies, name)),
          `${where} is not in package.json`,
        );
      }
    }
  }
});
