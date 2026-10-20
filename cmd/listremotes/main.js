import { env } from "node:process";
import { isTrue } from "@rfetch/lib/options";

import { config } from "../config/main.js";

/**
 * List all the remotes in the config file and defined in environment
 * variables, as `rclone listremotes`: one `name:` on each line. With
 * `--long`, the type too. With `--json`, the name, the type, the source
 * (`file` or `environment`) and the description of each remote.
 *
 * A remote of the variables has a variable `RFETCH_CONFIG_NAME_TYPE`, or
 * `RCLONE_CONFIG_NAME_TYPE`: its name is in lower case.
 * @param {string | Object} [filter] Only the remotes with this text in their
 *   names, as the argument of rclone.
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export async function listremotes(filter, flags = {}) {
  if (typeof filter !== "string") [filter, flags] = ["", filter ?? {}];
  const response = await config("dump");
  /** @type {Record<string, Record<string, string>>} */
  const sections = response.ok ? await response.json() : {};
  /** @type {{ name: string, type: string, source: string, description: string }[]} */
  const remotes = [];
  for (const [name, options] of Object.entries(sections)) {
    remotes.push({
      name,
      type: options.type ?? "",
      source: "file",
      description: options.description ?? "",
    });
  }
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^(?:RFETCH|RCLONE)_CONFIG_(.+)_TYPE$/);
    if (!match || typeof value !== "string") continue;
    const name = match[1].toLowerCase();
    const known = remotes.find((remote) => remote.name === name);
    if (known) {
      if (known.source === "environment") known.type = value;
      continue;
    }
    remotes.push({ name, type: value, source: "environment", description: "" });
  }
  const shown = remotes.filter((remote) => remote.name.includes(filter));

  if (isTrue(flags.json)) {
    const lines = shown.map((remote) => JSON.stringify(remote));
    return new Response(
      `[\n${lines.join(",\n")}${lines.length ? "\n" : ""}]\n`,
    );
  }
  if (isTrue(flags.long)) {
    const names = Math.max(0, ...shown.map(({ name }) => name.length + 1));
    const types = Math.max(0, ...shown.map(({ type }) => type.length));
    return new Response(
      shown.map(({ name, type, description }) =>
        `${`${name}:`.padEnd(names)} ${type.padEnd(types)} ${description}\n`
      ).join(""),
    );
  }
  return new Response(shown.map(({ name }) => `${name}:\n`).join(""));
}
