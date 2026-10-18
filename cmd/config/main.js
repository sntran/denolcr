import { env } from "node:process";

import { join } from "node:path";
import { CONFIG_NAME } from "@rfetch/lib/fspath";
import * as INI from "@rfetch/lib/ini";

/**
 * The names of remotes that rclone accepts (`fspath.CheckConfigName`):
 * letters, numbers, `_`, `-`, `.`, `+`, `@` and space, but not `-` or space
 * at the start, and not space at the end.
 */
export const NAME_REGEX = new RegExp(`^${CONFIG_NAME}$`, "u");

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

  const configFile = new INI.ConfigFile(ini);
  /**
   * @type {Object}
   */
  let config = configFile.config;

  /**
   * Changes the file, and answers with the remote. The other lines of the
   * file do not change, thus the comments of the person stay. An option
   * that the file cannot keep, for example a value with a line break, gives
   * 400 and the file does not change.
   * @param {(configFile: INI.ConfigFile) => void} change
   * @param {string} name
   */
  async function save(change, name) {
    try {
      change(configFile);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return new Response(error.message, { status: 400 });
    }
    await writeFile(file, configFile.toString());
    const remote = configFile.config[name];
    return new Response(INI.stringify(remote, { section: name }));
  }

  switch (subcommand) {
    case "create": { // Create a new remote with name, type and options.
      if (!NAME_REGEX.test(name)) {
        return new Response(`Invalid remote name: ${name}`, { status: 400 });
      }
      return await save((configFile) => configFile.set(name, options), name);
    }

    case "delete": // Delete an existing remote.
      configFile.delete(name);
      await writeFile(file, configFile.toString());
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

      // The whole file, with its comments, as `rclone config show`.
      if (typeof name !== "string") {
        return new Response(configFile.toString());
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
      return await save((configFile) => configFile.update(name, options), name);
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
