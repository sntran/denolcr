#!/usr/bin/env -S deno run --allow-all

/**
 * DenoLCR - Deno Lite Clone of Rclone.
 *
 * ```shell
 * ./main.js ls remote:path/to/folder/or/file
 * ./main.js cat remote:path/to/file
 * ./main.js check source:path dest:path
 * ./main.js copy source:/path/to/file destination:/path/to/file
 * ```
 */
import { argv, env, stdout } from "node:process";
import { parseArgs } from "./deps.js";

import * as commands from "./mod.js";

/** All optional params for the subcommand as an object. */
/**
 * @type {Options}
 */
const options = {};

const {
  _: [subcommand = "help", ...args],
  // @ts-ignore - Deno.args is not typed.
} = parseArgs(argv.slice(2), {
  alias: {
    "progress": "P", // Show progress during transfer
  },
  boolean: [
    "dry-run", // Do a trial run with no permanent changes
    "human-readable", // Print numbers in a human-readable format, sizes with suffix Ki|Mi|Gi|Ti|Pi
    "progress",
  ],
  negatable: [
    "progress",
  ],
  string: [
    "_",
    "header",
    "header-download",
    "header-upload",
    "transfers",
  ],
  collect: [
    "header",
    "header-download",
    "header-upload",
  ],
  default: {
    "dry-run": env["RCLONE_DRY_RUN"] === "true",
    progress: env["RCLONE_PROGRESS"] === "true",
    transfers: env["RCLONE_TRANSFERS"] || 4,
  },
  /**
   * Collects other optional params
   * @param {string} _arg
   * @param {string} [key]
   * @param {string} [value]
   * @returns {boolean | void}
   */
  unknown: (_arg, key, value) => {
    if (key) { // key is the flag name
      options[key.replace(/-/g, "_")] = `${value}`;
      return false;
    }
  },
});

(async () => {
  /** TODO merge global flags into config */
  const response = await commands[subcommand](...args, options);
  if (response.body) {
    for await (const chunk of response.body) {
      stdout.write(chunk);
    }
  }
})();
