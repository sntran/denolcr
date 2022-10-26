#!/usr/bin/env -S deno run --unstable --allow-all

/**
 * DenoLCR - Deno Lite Clone of Rclone.
 *
 * ```shell
 * rclone ls remote:path/to/folder/or/file
 * rclone cat remote:path/to/file
 * rclone check source:path dest:path
 * rclone copy source:/path/to/file destination:/path/to/file
 * ```
 */

import { basename, config_dir, INI, join, resolve, toLocaleISOString } from "./deps.ts";

export type Options = Record<string, string>;
export type Command<T extends unknown[]> = (
  ...args: [...T, Options?]
) => Promise<Response>;

type API = {
  [key: string]:
    | Command<[]>
    | Command<[string]>
    | Command<[string, string]>;
};

export type Remote = { type: string } & Options;

export interface Backend {
  fetch(request: Request): Response | Promise<Response>;
}

const NAME_REGEX = /^[\w.][\w.\s-]*$/;
const REMOTE_REGEX = /^(:)?(?:([\w.][\w.\s-]*(?:,[\w=,"':@\/]+)?):)?(.*)$/;

const globalFetch = globalThis.fetch;

/**
 * Extends global `fetch` with support for remote URL.
 *
 * The syntax of the paths passed to the rclone command are as follows.
 *
 * `/path/to/dir``
 *
 * This refers to the local file system.
 *
 * On Windows `\` may be used instead of `/` in local paths only, non local
 * paths must use `/`.
 *
 * These paths needn't start with a leading `/` - if they don't then they
 * will be relative to the current directory.
 *
 * `remote:path/to/dir`
 *
 * This refers to a directory `path/to/dir` on `remote:` as defined in the
 * config.
 *
 * `remote:/path/to/dir`
 *
 * On most backends this refers to the same directory as `remote:path/to/dir`
 * and that format should be preferred. On a very small number of remotes
 * (FTP, SFTP, ..) this will refer to a different directory. On these, paths
 * without a leading `/` will refer to your "home" directory and paths with a
 * leading `/` will refer to the root.
 *
 * `:backend:path/to/dir`
 *
 * This is an advanced form for creating remotes on the fly. `backend` should
 * be the name or prefix of a backend (the `type` in the config file) and all
 * the configuration for the backend should be provided on the command line
 * (or in environment variables).
 */
export async function fetch(
  input: string | Request | URL,
  init?: RequestInit,
): Promise<Response> {
  if (
    typeof input !== "string" || input.startsWith("https://") ||
    input.startsWith("http://")
  ) {
    return globalFetch(input, init);
  }

  const [, colon, remote = "local", path] = input.match(REMOTE_REGEX) || [];
  if (!remote && !path) {
    return globalFetch(input, init);
  }

  // `searchParams` may contain other flags not for the current backend.
  const { pathname, searchParams } = new URL(path, "file:");

  // Remote can be connection string with arguments separated by commas.
  let [name, ...args] = remote.split(",");

  let type = "";

  if (colon || remote === "local") { // the location has format `:type:path/to/file`
    type = name;
    name = "";
  } else {
    const response = await Rclone.config("show", name, undefined, {
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Remote ${name} not found in config.`);
    }
    const config: Options = await response.json();
    type = config.type;

    Object.entries(config).forEach(([key, value]) => {
      if (key === "type") {
        return;
      }

      key = `${type}-${key}`;
      // Config has lower precedence to only supplement flags.
      if (!searchParams.has(key)) {
        searchParams.set(key, value);
      }
    });
  }

  // Overrides flags with arguments for current backend from connection string.
  args.forEach((arg) => {
    const [key, value = "true"] = arg.split("=");
    searchParams.set(`${type}-${key.replace(/_/g, "-")}`, value);
  });

  /** Uses only flags for the current backend. */
  const params = new URLSearchParams();
  searchParams.forEach((value, key) => {
    if (key.startsWith(`${type}-`)) {
      params.set(key.replace(`${type}-`, ""), value);
    }
  });

  if (init?.method === "TRACE") {
    const headers = new Headers(init?.headers);
    let body = `TRACE ${pathname}?${params} HTTP/1.1\r`;
    // Reflects the request as response body.
    for (const [name, value] of headers) {
      body += `${name}: ${value}\r`;
    }
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "message/http",
        "Via": `${type}/1.1 ${name}`.trim(),
      },
    });
  }

  const { fetch } = await import(`rclone/backend/${type}/main.ts`);

  const url = new URL(`${pathname}?${params}`, import.meta.url);
  const request = new Request(url, init);
  return fetch(request);
}

globalThis.fetch = fetch;

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
    case "update": {// Update options in an existing remote.
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

export async function lsjson(location: string, flags?: Options): Promise<Response> {
  const init = { method: "HEAD" };
  const url = `${location}?${new URLSearchParams(flags)}`;
  const { headers } = await fetch(url, init);

  const links = headers.get("Link")?.split(",").map((link) => {
    const [_, uri] = link.match(/<(.*)>/) || [];
    return decodeURIComponent(uri);
  }) || [];

  const files = [];

  for await (let link of links) {
    const url = `${location}/${link}?${new URLSearchParams(flags)}`;
    const { headers } = await fetch(url, init);
    const size = Number(headers.get("Content-Length"));
    const IsDir = link.endsWith("/");
    if (IsDir) {
      link = link.slice(0, -1);
    }

    files.push({
      Path: `${link}`,
      Name: link,
      Size: IsDir ? -1 : size,
      MimeType: headers.get("Content-Type"),
      ModTime: toLocaleISOString(headers.get("Last-Modified")),
      IsDir,
    });
  }

  return Response.json(files);
}

export function cat(location: string, flags?: Options): Promise<Response> {
  return fetch(location, flags);
}

export function rcat(destination: string, flags?: Options): Promise<Response> {
  return fetch(`${destination}?${new URLSearchParams(flags)}`, {
    method: "PUT",
    body: Deno.stdin.readable,
  });
}

/**
 * Copy files from source to dest, skipping identical files.
 *
 * Copy the source to the destination. Does not transfer files that are
 * identical on source and destination, testing by size and modification time
 * or MD5SUM. Doesn't delete files from the destination. If you want to also
 * delete files from destination, to make it match source, use the `sync`
 * command instead.
 *
 * Note that it is always the contents of the directory that is synced, not
 * the directory itself. So when `source:path` is a directory, it's the
 * contents of source:path that are copied, not the directory name and
 * contents.
 *
 * To copy single files, use the `copyto` command instead.
 *
 * If `dest:path` doesn't exist, it is created and the source:path contents
 * go there.
 */
export async function copy(
  source: string,
  target: string,
  flags?: Options,
): Promise<Response> {
  /** @TODO: Handle copy folder */
  const params = new URLSearchParams(flags);
  const { body } = await fetch(`${source}?${params}`);
  return fetch(`${target}?${params}`, { method: "PUT", body });
}

// @TODO: Type `Rclone` as `API`.
export const Rclone = {
  config,
  lsjson,
  cat,
  rcat,
  copy,
};

if (import.meta.main) {
  const { parseFlags } = await import("./deps.ts");

  /** All optional params for the command as an object. */
  const options: Options = {};
  /**
   * Sets default options from environment variables first.
   * They can be overridden by command line flags resolved in `unknown` fn.
   */
  const env = Deno.env.toObject();
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("RCLONE_")) {
      options[key.slice(7).toLowerCase().replace(/_/g, "-")] = value;
    }
  }

  const {
    _: [command, ...args],
    ...globalFlags
  } = parseFlags(Deno.args, {
    alias: {
      "progress": "P", // Show progress during transfer
    },
    boolean: [
      "dry-run", // Do a trial run with no permanent changes
      "human-readable", // Print numbers in a human-readable format, sizes with suffix Ki|Mi|Gi|Ti|Pi
      "progress",
    ],
    negatable: [
      "progress",
    ],
    string: [
      "_",
      "header",
      "header-download",
      "header-upload",
      "transfers",
    ],
    collect: [
      "header",
      "header-download",
      "header-upload",
    ],
    default: {
      "dry-run": Deno.env.get("RCLONE_DRY_RUN ") === "true",
      progress: Deno.env.get("RCLONE_PROGRESS") === "true",
      transfers: Deno.env.get("RCLONE_TRANSFERS") || 4,
    },
    /** Collects other optional params */
    unknown: (_arg: string, key?: string, value?: unknown) => {
      if (key) { // key is the flag name
        options[key] = `${value}`;
        return false;
      }
    },
  }) as {
    _: [string, ...[string] | [string, string]];
  } & Options;

  /** @TODO merge global flags into config */
  // @ts-ignore valid arguments.
  const response = await Rclone[command](...args, options);
  response.body?.pipeTo(Deno.stdout.writable);
}
