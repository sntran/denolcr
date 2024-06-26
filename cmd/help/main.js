import * as backends from "../../backend/main.js";
import * as commands from "../main.js";

/**
 * @type {Object<string, () => string>}
 */
const usage = {};

usage["commands"] = () =>
  `Usage:
  rclone [flags]
  rclone [command]

Available Commands:
  ${Object.keys(commands).join("\n  ")}

Use "rclone [command] --help" for more information about a command.
Use "rclone help flags" for to see the global flags.
Use "rclone help backends" for a list of supported services.
`;

usage["flags"] = () =>
  `Usage:
  rclone help flags [<regexp to match>] [flags]

Flags:
  -h, --help   help for flags

Global Flags:

Backend Flags:
`;

usage["backends"] = () =>
  `All backends:

  ${Object.keys(backends).join("\n  ")}

To see more info about a particular backend use:
  rclone help backend <name>
`;

/**
 * Show help for rclone commands, flags and backends
 * @param {string} [type] - The type of help to show
 * @returns {Response}
 */
export function help(type) {
  if (typeof type !== "string") {
    type = "commands";
  }
  return new Response(usage[type]());
}
