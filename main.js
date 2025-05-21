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
import { parseArgs } from "node:util";

import * as commands from "./mod.js";

/** Optional params for the subcommand. */
const options = {
  "dry-run": {
    type: "boolean",
    default: env["RCLONE_DRY_RUN"] === "true",
  },
  "header": {
    type: "string",
    multiple: true,
  },
  "header-download": {
    type: "string",
    multiple: true,
  },
  "header-upload": {
    type: "string",
    multiple: true,
  },
  "human-readable": {
    type: "boolean",
  },
  "progress": {
    type: "boolean",
    short: "P",
    default: env["RCLONE_PROGRESS"] === "true",
  },
  "transfers": {
    type: "string",
    default: env["RCLONE_TRANSFERS"] || "4",
  }
};

const {
  values: flags,
  positionals: [
    subcommand = "help",
    ...args
  ],
} = parseArgs({
  args: argv.slice(2),
  options,
  strict: false,
  allowPositionals: true,
  allowNegative: true,
  tokens: true,
});

for (const name of Object.keys(flags)) {
  // Adds snake_case version of the flag.
  flags[name.replace(/-/g, "_")] = flags[name];
}

(async () => {
  /** TODO merge global flags into config */
  const response = await commands[subcommand](...args, flags);
  if (response.body) {
    for await (const chunk of response.body) {
      stdout.write(chunk);
    }
  }
})();
