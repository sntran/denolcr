import { env } from "node:process";

import { join } from "node:path";
import * as INI from "../../lib/ini.js";

/**
 * The names of remotes that rclone accepts (`fspath.CheckConfigName`):
 * letters, numbers, `_`, `-`, `.`, `+`, `@` and space, but not `-` or space
 * at the start, and not space at the end.
 */
export const NAME_REGEX = /^[\w\p{L}\p{N}.+@]+(?:[ -]+[\w\p{L}\p{N}.+@-]+)*$/u;

/**
 * @typedef {Object<string, string>} Options
 */

/**
 * @typedef {(
 *  "create" |
 *  "delete" |
 *  "disconnect" |
 *  "dump" |
 *  "file" |
 *  "password" |
 *  "paths" |
 *  "providers" |
 *  "reconnect" |
 *  "show" |
 *  "touch" |
 *  "update" |
 *  "userinfo"
 * )} Subcommand
 */

/**
 * Handles configuration of rfetch.
 *
 * Takes a subcommand and optional arguments.
 *
 * @param {Subcommand} subcommand - The subcommand to run.
 * @param {string} [name] - The name of the remote.
 * @param {Options} [options] - The options to set.
 * @param {RequestInit} [init] - The request init.
 * @returns {Promise<Response>} The response.
 */
export async function config(subcommand, name, options, init) {
  const { readFile, writeFile } = await import("node:fs/promises");

  // Order as specified at https://rclone.org/docs/#config-config-file.
  const PATHS = [
    "rfetch.conf",
    join(config_dir(), "rfetch", "rfetch.conf"),
    join(env["HOME"], ".rfetch.conf"),
    "rclone.conf",
    join(config_dir(), "rclone", "rclone.conf"),
    join(env["HOME"], ".rclone.conf"),
  ];
  // With no file, the file is the default file of rclone.
  let file = PATHS[4], ini = "";
  for await (const path of PATHS) {
    try {
      ini = await readFile(path, { encoding: "utf8" });
      file = path;
      break;
    } catch (_error) {
      continue;
    }
  }

  /**
   * @type {Object}
   */
  let config = INI.parse(ini);

  /**
   * Writes the config to the file, and answers with the remote. An option
   * that the file cannot keep, for example a value with a line break, gives
   * 400 and the file does not change.
   * @param {Object} config
   * @param {string} name
   */
  async function save(config, name) {
    let text;
    try {
      text = INI.stringify(config);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return new Response(error.message, { status: 400 });
    }
    await writeFile(file, text);
    return new Response(INI.stringify(config[name], { section: name }));
  }

  switch (subcommand) {
    case "create": { // Create a new remote with name, type and options.
      if (!NAME_REGEX.test(name)) {
        return new Response(`Invalid remote name: ${name}`, { status: 400 });
      }
      config[name] = options;
      return await save(config, name);
    }

    case "delete": // Delete an existing remote.
      delete config[name];
      await writeFile(file, INI.stringify(config));
      return new Response();

    case "disconnect": // Disconnects user from remote
      return new Response();

    case "dump": // Dump the config file as JSON.
      return Response.json(config);

    case "file": // Show path of configuration file in use.
      return new Response(file);

    case "password": // Update password in an existing remote.
    case "paths": // Show paths used for configuration, cache, temp etc.
    case "providers": // List in JSON format all the providers and options.
    case "reconnect": // Re-authenticates user with remote.
      return new Response();

    case "show": // Print (decrypted) config file, or the config for a single remote.
      if (typeof name === "string") {
        // Only an own key: the name "toString" is not a remote.
        if (!Object.hasOwn(config, name)) {
          return new Response("", { status: 404 });
        }
        config = config[name];
      }

      if (new Headers(init?.headers).get("Accept") === "application/json") {
        return Response.json(config);
      }

      return new Response(INI.stringify(config, { section: name }));

    case "touch": // Ensure configuration file exists.
    case "update": { // Update options in an existing remote.
      /**
       * @type {Object}
       */
      if (!Object.hasOwn(config, name)) {
        return new Response("", { status: 404 });
      }
      const remote = config[name];

      Object.assign(remote, options);
      return await save(config, name);
    }

    case "userinfo": // Prints info about logged in user of remote.
    default:
      return new Response();
  }
}

/**
 * Retrieves the configuration directory for current platform.
 * @returns {string | null}
 */
export function config_dir() {
  let dir = env["XDG_CONFIG_HOME"];
  if (!dir) {
    dir = env["APPDATA"]; // Windows
  }
  if (!dir) {
    dir = env["HOME"];
    if (dir) {
      dir += "/.config";
    }
  }

  return dir;
}
