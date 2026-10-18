import { backends } from "../../backend/main.js";
import { FLAGS } from "../flags.js";
import { FOLDERS } from "../folders.js";

/**
 * @type {Object<string, () => string>}
 */
const usage = {};

usage["commands"] = () =>
  `Usage:
  rfetch [flags]
  rfetch [command]

Available Commands:
  ${Object.keys(FOLDERS).join("\n  ")}

Use "rfetch [command] --help" for more information about a command.
Use "rfetch help flags" for to see the global flags.
Use "rfetch help backends" for a list of supported services.
`;

usage["flags"] = () =>
  `Usage:
  rfetch help flags

Global Flags:
${
    Object.entries(FLAGS).map(([name, { type, short }]) =>
      `  ${short ? `-${short}, ` : "    "}--${name}${
        type === "string" ? " string" : ""
      }`
    ).join("\n")
  }

Backend Flags:
  --TYPE-NAME string   The option NAME of the backend TYPE, for example
                       --crypt-password or --s3-chunk-size. A boolean
                       option takes no value, for example --http-no-head.
`;

usage["backends"] = () =>
  `All backends:

  ${Object.keys(backends).join("\n  ")}

To see more info about a particular backend use:
  rfetch help backend <name>
`;

/**
 * Show help for rfetch commands, flags and backends
 * @param {string} [type] - The type of help to show
 * @returns {Response}
 */
export function help(type) {
  if (typeof type !== "string") {
    type = "commands";
  }
  return new Response(usage[type]());
}
