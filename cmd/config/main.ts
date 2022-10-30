import { config_dir, INI, join } from "../../deps.ts";

const NAME_REGEX = /^[\w.][\w.\s-]*$/;

type Options = Record<string, string>;

/**
 * Handles configuration of rclone.
 *
 * Takes a subcommand and optional arguments.
 */
export async function config(
  subcommand: string,
  name?: string,
  options?: Options,
  init?: RequestInit,
): Promise<Response> {
  let file = "", ini = "";
  // Order as specified at https://rclone.org/docs/#config-config-file.
  const PATHS = [
    "rclone.conf",
    join(config_dir()!, "rclone", "rclone.conf"),
    join(Deno.env.get("HOME")!, ".rclone.conf"),
  ];
  for await (const path of PATHS) {
    try {
      ini = await Deno.readTextFile(path);
      file = path;
      break;
    } catch (_error) {
      continue;
    }
  }

  let config = INI.parse(ini) as Record<string, unknown>;
  const encodeOptions = {
    section: "",
    whitespace: true,
  };

  switch (subcommand) {
    case "create": { // Create a new remote with name, type and options.
      name = name as string;
      if (!NAME_REGEX.test(name)) {
        return new Response(null, {
          status: 400,
          statusText: `Invalid remote name: ${name}`,
        });
      }
      config[name] = options!;
      await Deno.writeTextFile(
        file,
        INI.stringify(config, encodeOptions).trim(),
      );
      encodeOptions.section = name;
      return new Response(INI.stringify(config[name], encodeOptions).trim());
    }

    case "delete": // Delete an existing remote.
      delete config[name as string];
      await Deno.writeTextFile(
        file,
        INI.stringify(config, encodeOptions).trim(),
      );
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
        config = config[name] as Record<string, unknown>;

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
      const remote = config[name as string];
      if (!remote) {
        return new Response("", { status: 404 });
      }

      Object.assign(
        remote as Record<string, unknown>,
        options,
      );
      await Deno.writeTextFile(
        file,
        INI.stringify(config, encodeOptions).trim(),
      );
      encodeOptions.section = name!;
      return new Response(INI.stringify(config[name!], encodeOptions).trim());
    }

    case "userinfo": // Prints info about logged in user of remote.
    default:
      return new Response();
  }
}
