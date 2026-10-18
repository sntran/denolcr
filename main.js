#!/usr/bin/env node

/**
 * rfetch - fetching between remotes
 *
 * ```shell
 * ./main.js ls remote:path/to/folder/or/file
 * ./main.js cat remote:path/to/file
 * ./main.js check source:path dest:path
 * ./main.js copy source:/path/to/file destination:/path/to/file
 * ```
 */
import process, { argv, env, stderr, stdout } from "node:process";
import { once } from "node:events";
import { parseArgs } from "node:util";

// The import sets the global `fetch`, which reads the paths of remotes.
import "./fetch.js";

import { FOLDERS } from "./cmd/folders.js";

/** Optional params for the subcommand. */
const options = {
  // The address of `serve`, for example `--addr :8080`.
  "addr": {
    type: "string",
  },
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
  },
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
  let name = subcommand;
  if (!Object.hasOwn(FOLDERS, name)) {
    stderr.write(`Error: unknown command "${name}" for "rfetch"\n`);
    process.exitCode = 1;
    name = "help";
  }
  const module = await import(`./cmd/${FOLDERS[name]}/main.js`);
  /** TODO merge global flags into config */
  const response = await module[name](...args, flags);
  if (!response.ok) {
    // As rclone: the exit code 3 is "directory not found", and 1 is an
    // other error.
    const text = (await response.text()).trim() || response.statusText ||
      (response.status === 404 ? "not found" : `status ${response.status}`);
    stderr.write(`Error: ${text}\n`);
    process.exitCode = response.status === 404 ? 3 : 1;
    return;
  }
  if (response.body) {
    // A reader that closes the pipe, for example `head`, stops the command.
    stdout.on("error", (error) => {
      if (error.code === "EPIPE") process.exit();
      throw error;
    });
    for await (const chunk of response.body) {
      // Waits when the pipe is full: else the output stays in memory.
      if (!stdout.write(chunk)) await once(stdout, "drain");
    }
  }
})();
