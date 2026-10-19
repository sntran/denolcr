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
import process, { argv, stderr, stdout } from "node:process";
import { once } from "node:events";

// The import sets the global `fetch`, which reads the paths of remotes.
import "./fetch.js";

import { backends } from "./backend/main.js";
import { parseFlags } from "./cmd/flags.js";
import { FOLDERS, PATHS } from "./cmd/folders.js";
import { encodeLocation } from "@rfetch/lib/fspath";

(async () => {
  /** @type {Awaited<ReturnType<typeof parseFlags>>} */
  let parsed;
  try {
    parsed = await parseFlags(argv.slice(2), backends);
  } catch (error) {
    // As rclone: for example `Error: unknown flag: --nosuch`.
    stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const { flags, positionals: [subcommand = "help", ...positionals] } = parsed;

  let name = subcommand;
  let args = positionals;
  if (!Object.hasOwn(FOLDERS, name)) {
    stderr.write(`Error: unknown command "${name}" for "rfetch"\n`);
    process.exitCode = 1;
    [name, args] = ["help", []];
  }
  // `rfetch COMMAND --help` shows the help.
  if (flags.help) [name, args] = ["help", []];
  // A path of the command line is a path of rclone: each name keeps its
  // characters, for example "%", "?", "#" and a space at the end. A path that
  // is not correct goes to the command as it is: the command gives its
  // error.
  args = args.map((arg, index) => {
    if (!PATHS[name]?.includes(index)) return arg;
    try {
      return encodeLocation(arg);
    } catch {
      return arg;
    }
  });
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
