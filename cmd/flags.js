/**
 * The flags of the command line, as in rclone. Each flag has a type:
 *
 * - A flag of type `boolean` takes no value, for example `--recursive`, or a
 *   value after `=`, for example `--dir-slash=false`.
 * - A flag of type `string` takes the next argument as its value, for
 *   example `--addr :8080`, or a value after `=`, for example
 *   `--addr=:8080`.
 *
 * The `parseArgs` of Node.js takes the next argument as the value only for a
 * flag that it knows as `string`: it reads an unknown flag as `boolean`, and
 * its value as an argument of the command. Thus rfetch tells it the type of
 * each flag, and an unknown flag is an error, as in rclone.
 */
import { env } from "node:process";
import { parseArgs } from "node:util";

/**
 * The value of a variable of rfetch, or of rclone for compatibility, for
 * example `RFETCH_DRY_RUN` or `RCLONE_DRY_RUN`.
 * @param {string} name For example `DRY_RUN`.
 * @returns {string | undefined}
 */
function variable(name) {
  return env[`RFETCH_${name}`] ?? env[`RCLONE_${name}`];
}

/**
 * The flags of the commands, in the format of `parseArgs`.
 * @type {Record<string, import("node:util").ParseArgsOptionDescriptor>}
 */
export const FLAGS = {
  // `serve`
  "addr": { type: "string" },
  // `tree`
  "all": { type: "boolean" },
  // `copyurl`
  "auto-filename": { type: "boolean", short: "a" },
  // `hashsum`, `checksum`
  "base64": { type: "boolean" },
  // The checks, the deletes and the sums
  "checkers": { type: "string", default: variable("CHECKERS") || "8" },
  // `hashsum`, `md5sum`, `sha1sum`
  "checkfile": { type: "string" },
  // `check`
  "combined": { type: "string" },
  // `copy`, `move`
  "create-empty-src-dirs": { type: "boolean" },
  // `lsf`
  "csv": { type: "boolean" },
  // `move`
  "delete-empty-src-dirs": { type: "boolean" },
  // `check`
  "differ": { type: "string" },
  // `lsf`
  "dir-slash": { type: "boolean", short: "d" },
  // `tree`
  "dirsfirst": { type: "boolean" },
  // `lsf`, `tree`
  "dirs-only": { type: "boolean" },
  // `check`, `checksum`, the sums
  "download": { type: "boolean" },
  "dry-run": {
    type: "boolean",
    short: "n",
    default: variable("DRY_RUN") === "true",
  },
  // `check`
  "error": { type: "string" },
  // `lsf`
  "files-only": { type: "boolean" },
  // `lsf`
  "format": { type: "string", short: "F" },
  // `tree`
  "full-path": { type: "boolean" },
  "header": { type: "string", multiple: true },
  "header-download": { type: "string", multiple: true },
  // `copyurl`
  "header-filename": { type: "boolean" },
  "header-upload": { type: "string", multiple: true },
  "help": { type: "boolean", short: "h" },
  "human-readable": { type: "boolean" },
  // `copy`, `move`
  "ignore-existing": { type: "boolean" },
  // `copy`, `move`
  "ignore-times": { type: "boolean", short: "I" },
  // `size`, `listremotes`
  "json": { type: "boolean" },
  // `rmdirs`
  "leave-root": { type: "boolean" },
  // `tree`
  "level": { type: "string" },
  // `touch`
  "localtime": { type: "boolean" },
  // `listremotes`
  "long": { type: "boolean" },
  // `check`
  "match": { type: "string" },
  // The lists
  "max-depth": { type: "string" },
  // `check`
  "missing-on-dst": { type: "string" },
  // `check`
  "missing-on-src": { type: "string" },
  // `tree`
  "modtime": { type: "boolean" },
  // `copyurl`
  "no-clobber": { type: "boolean" },
  // `touch`
  "no-create": { type: "boolean", short: "C" },
  // `tree`
  "noindent": { type: "boolean" },
  // `tree`
  "noreport": { type: "boolean" },
  // `check`, `checksum`
  "one-way": { type: "boolean" },
  // `hashsum`
  "output-file": { type: "string" },
  // `serve webdav`
  "pass": { type: "string" },
  // `copyurl`
  "print-filename": { type: "boolean", short: "p" },
  "progress": {
    type: "boolean",
    short: "P",
    default: variable("PROGRESS") === "true",
  },
  // Only the errors in the log.
  "quiet": { type: "boolean", short: "q" },
  // `tree`
  "quote": { type: "boolean" },
  // `serve webdav`
  "read-only": { type: "boolean" },
  // The lists, `touch`
  "recursive": { type: "boolean", short: "R" },
  // `cryptdecode`
  "reverse": { type: "boolean" },
  // `delete`
  "rmdirs": { type: "boolean" },
  // `lsf`
  "separator": { type: "string", short: "s" },
  // `tree`
  "size": { type: "boolean" },
  // `copy`, `move`, `check`
  "size-only": { type: "boolean" },
  // `tree`
  "sort": { type: "string" },
  // `tree`
  "sort-modtime": { type: "boolean" },
  // `tree`
  "sort-reverse": { type: "boolean", short: "r" },
  // `copyurl`
  "stdout": { type: "boolean" },
  // `touch`
  "timestamp": { type: "string", short: "t" },
  "transfers": { type: "string", default: variable("TRANSFERS") || "4" },
  // `serve webdav`
  "user": { type: "string" },
};

/**
 * The options of a backend, for example `{ boolean: ["no_head"], string:
 * ["url"] }`. An option of `default` that is in no list is a `string`.
 * @typedef {Object} BackendOptions
 * @property {string[]} [boolean]
 * @property {string[]} [string]
 * @property {Record<string, unknown>} [default]
 */

/**
 * The values that `strconv.ParseBool` of Go reads, as rclone.
 * @type {Record<string, boolean>}
 */
const BOOLEANS = {
  "1": true,
  "t": true,
  "T": true,
  "true": true,
  "TRUE": true,
  "True": true,
  "0": false,
  "f": false,
  "F": false,
  "false": false,
  "FALSE": false,
  "False": false,
};

/**
 * Reads the flags and the arguments of a command line.
 *
 * A flag of a backend has the type of the backend before its name, for
 * example `--crypt-password` for the option `password` of `crypt`. Its type
 * comes from the `options` of the module of the backend. Only the backends
 * that the flags tell load.
 *
 * Each flag is in the result with its name, for example `dry-run`, and with
 * `_` in the place of `-`, for example `dry_run`.
 * @param {string[]} args The arguments, with no program, for example
 *   `["lsjson", "--max-depth", "2", "remote:"]`.
 * @param {Record<string, () => Promise<{ options?: BackendOptions }>>} backends
 *   The modules of the backends, by type.
 * @returns {Promise<{ flags: Record<string, unknown>, positionals: string[] }>}
 * @throws {Error} For an unknown flag, a flag with no value, or a value that
 *   is not a boolean, with the message of rclone.
 */
export async function parseFlags(args, backends) {
  /** @type {Record<string, import("node:util").ParseArgsOptionDescriptor>} */
  const options = { ...FLAGS };

  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2).split("=", 1)[0];
    if (Object.hasOwn(options, name)) continue;
    const type = name.slice(0, name.indexOf("-"));
    if (!type || !Object.hasOwn(backends, type)) continue;
    const declared = (await backends[type]()).options ?? {};
    const booleans = declared.boolean ?? [];
    const names = [
      ...booleans,
      ...declared.string ?? [],
      ...Object.keys(declared.default ?? {}),
    ];
    for (const option of names) {
      options[`${type}-${option.replaceAll("_", "-")}`] = {
        type: booleans.includes(option) ? "boolean" : "string",
      };
    }
  }

  const { values, positionals, tokens } = parseArgs({
    args,
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const option = options[token.name];
    if (!option) throw new Error(`unknown flag: ${token.rawName}`);
    if (option.type === "string" && token.value === undefined) {
      throw new Error(`flag needs an argument: ${token.rawName}`);
    }
    if (option.type === "boolean" && token.value !== undefined) {
      const value = Object.hasOwn(BOOLEANS, token.value)
        ? BOOLEANS[token.value]
        : undefined;
      if (value === undefined) {
        throw new Error(
          `invalid argument "${token.value}" for "${token.rawName}" flag`,
        );
      }
      values[token.name] = value;
    }
  }

  /** @type {Record<string, unknown>} */
  const flags = {};
  for (const [name, value] of Object.entries(values)) {
    flags[name] = value;
    flags[name.replaceAll("-", "_")] = value;
  }
  return { flags, positionals };
}
