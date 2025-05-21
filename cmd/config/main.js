import { env } from "node:process";

import { config_dir, INI, join } from "../../deps.js";

const NAME_REGEX = /^[\w.][\w.\s-]*$/;

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

  let file = "", ini = "";
  // Order as specified at https://rclone.org/docs/#config-config-file.
  const PATHS = [
    "rfetch.conf",
    join(config_dir(), "rfetch", "rfetch.conf"),
    join(env["HOME"], ".rfetch.conf"),
    "rclone.conf",
    join(config_dir(), "rclone", "rclone.conf"),
    join(env["HOME"], ".rclone.conf"),
  ];
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
  const encodeOptions = {
    section: "",
    whitespace: true,
  };

  switch (subcommand) {
    case "create": { // Create a new remote with name, type and options.
      if (!NAME_REGEX.test(name)) {
        return new Response(null, {
          status: 400,
          statusText: `Invalid remote name: ${name}`,
        });
      }
      config[name] = options;
      await writeFile(
        file,
        INI.stringify(config, encodeOptions).trim(),
      );
      encodeOptions.section = name;
      return new Response(INI.stringify(config[name], encodeOptions).trim());
    }

    case "delete": // Delete an existing remote.
      delete config[name];
      await writeFile(file, INI.stringify(config, encodeOptions).trim());
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
        config = config[name];

        if (!config) {
          return new Response("", { status: 404 });
        }

        encodeOptions.section = name;
      }

      if (new Headers(init?.headers).get("Accept") === "application/json") {
        return Response.json(config);
      }

      return new Response(INI.stringify(config, encodeOptions).trim());

    case "touch": // Ensure configuration file exists.
    case "update": { // Update options in an existing remote.
      /**
       * @type {Object}
       */
      const remote = config[name];
      if (!remote) {
        return new Response("", { status: 404 });
      }

      Object.assign(remote, options);
      await writeFile(file, INI.stringify(config, encodeOptions).trim());
      encodeOptions.section = name;
      return new Response(INI.stringify(config[name], encodeOptions).trim());
    }

    case "userinfo": // Prints info about logged in user of remote.
    default:
      return new Response();
  }
}
