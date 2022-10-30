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

export interface File {
  [key: string]: unknown;
  ID: string;
  OrigID: string;
  IsDir: boolean;
  MimeType: string;
  ModTime: string;
  Name: string;
  Encrypted: string;
  EncryptedPath: string;
  Path: string;
  Size: number;
  Tier: string;
  Metadata: Record<string, string>;
}

const FORMATS: Record<string, string> = {
  "p": "Path",
  "s": "Size",
  "t": "ModTime",
  "h": "Hash",
  "i": "ID",
  "o": "OrigID",
  "m": "MimeType",
  "e": "Encrypted",
  "T": "Tier",
  "M": "Metadata",
}

const encoder = new TextEncoder();

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
 *
 * ## Precedence
 *
 * The various different methods of backend configuration are read in this
 * order and the first one with a value is used.
 *
 * - Parameters in connection strings, e.g. `myRemote,skip_links:`
 * - Flag values as supplied on the command line, e.g. `--skip-links`
 * - Remote specific environment vars, e.g. `RCLONE_CONFIG_MYREMOTE_SKIP_LINKS`
 * - Backend-specific environment vars, e.g. `RCLONE_LOCAL_SKIP_LINKS`
 * - Backend generic environment vars, e.g. `RCLONE_SKIP_LINKS`
 * - Config file, e.g. `skip_links = true`.
 * - Default values, e.g. `false` - these can't be changed.
 *
 * So if both `--skip-links` is supplied on the command line and an environment
 * variable `RCLONE_LOCAL_SKIP_LINKS` is set, the command line flag will take
 * preference.
 *
 * For non backend configuration the order is as follows:
 *
 * - Flag values as supplied on the command line, e.g. `--stats 5s`.
 * - Environment vars, e.g. `RCLONE_STATS=5s`.
 * - Default values, e.g. `1m` - these can't be changed.
 *
 * ## Other environment variables
 */
export async function fetch(
  input: string | Request | URL,
  init: RequestInit = {},
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

  // The final params.
  const params = new URLSearchParams();

  /**
   * Sets backend generic environment vars first.
   */
  const env = Deno.env.toObject();
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("RCLONE_")) {
      const shortKey = key.slice(7).toLowerCase().replace(/_/g, "-");
      params.set(shortKey, value);
    }
  }

  // Remote can be connection string with arguments separated by commas.
  let [name, ...args] = remote.split(",");

  let config: Options;

  if (colon || remote === "local") { // the location has format `:type:path/to/file`
    config = { type: name };
    name = "";
  } else {
    const response = await Rclone.config("show", name, undefined, {
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Remote ${name} not found in config.`);
    }
    config = await response.json();
  }

  const type = config.type;
  delete config.type;

  // Stores config into params if not already set, with lowest precedence.
  Object.entries(config).forEach(([key, value]) => {
    if (!params.has(key)) {
      params.set(key, value);
    }
  });

  // Overrides with backend-specific environment vars.
  let envPrefix = `RCLONE_${type.toUpperCase()}_`;
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(envPrefix)) {
      const shortKey = key.slice(envPrefix.length).toLowerCase().replace(/_/g, "-");
      params.set(shortKey, value);

      // Deletes any params that are already set by environment vars.
      params.delete(`${type}-${shortKey}`);
    }
  }

  // Overrides with remote specific environment vars
  envPrefix = `RCLONE_CONFIG_${name.toUpperCase()}_`;
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(envPrefix)) {
      const shortKey = key.slice(envPrefix.length).toLowerCase().replace(/_/g, "-");
      params.set(shortKey, value);

      // Deletes any params that are already set by environment vars.
      params.delete(`config-${name}-${shortKey}`);
    }
  }

  // `searchParams` may contain other flags not for the current backend.
  const { pathname, searchParams } = new URL(path, "file:");

  // Overrides with flags in request's search params.
  searchParams.forEach((value, key) => {
    if (key.startsWith(`${type}-`)) {
      params.set(key.replace(`${type}-`, ""), value);
    }
  });

  // Overrides with parameters in connection string.
  args.forEach((arg) => {
    const [key, value = "true"] = arg.split("=");
    params.set(`${key.replace(/_/g, "-")}`, value);
  });

  const headers = new Headers(init.headers);

  /** Converts `user` and `pass` params into Authorization header */
  const user = params.get("user") || "";
  const pass = params.get("pass") || "";
  if (user) {
    headers.set("Authorization", `Basic ${btoa(`${user}:${pass}`)}`);
    params.delete("user");
    params.delete("pass");
  }

  if (init.method === "TRACE") {
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
  const request = new Request(url, {
    ...init,
    headers,
  });
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

/**
 * List directories and objects in the path in JSON format.
 *
 * The output is an array of Items, where each Item looks like this
 *
 * ```json
 * {
 *   "Hashes" : {
 *     "SHA-1" : "f572d396fae9206628714fb2ce00f72e94f2258f",
 *     "MD5" : "b1946ac92492d2347c6235b4d2611184",
 *     "DropboxHash" : "ecb65bb98f9d905b70458986c39fcbad7715e5f2fcc3b1f07767d7c83e2438cc"
 *   },
 *   "ID": "y2djkhiujf83u33",
 *   "OrigID": "UYOJVTUW00Q1RzTDA",
 *   "IsBucket" : false,
 *   "IsDir" : false,
 *   "MimeType" : "application/octet-stream",
 *   "ModTime" : "2017-05-31T16:15:57.034468261+01:00",
 *   "Name" : "file.txt",
 *   "Encrypted" : "v0qpsdq8anpci8n929v3uu9338",
 *   "EncryptedPath" : "kja9098349023498/v0qpsdq8anpci8n929v3uu9338",
 *   "Path" : "full/path/goes/here/file.txt",
 *   "Size" : 6,
 *   "Tier" : "hot",
 * }
 * ```
 *
 * The `Path` field will only show folders below the remote path being listed.
 * If "remote:path" contains the file "subfolder/file.txt", the `Path` for
 * "file.txt" will be "subfolder/file.txt", not "remote:path/subfolder/file.txt".
 * When used without `--recursive` the `Path` will always be same as `Name`.
 *
 * The whole output can be processed as a JSON blob, or alternatively it can be
 * processed line by line as each item is written one to a line.
 *
 * Note that `ls` and `lsl` recurse by default - use `--max-depth 1` to stop
 * the recursion.
 *
 * The other list commands `lsd`, `lsf`, `lsjson` do not recurse by default -
 * use `--recursive` to make them recurse.
 */
export async function lsjson(location: string, flags: Options = {}): Promise<Response> {
  const init = { method: "HEAD" };
  const url = `${location}?${new URLSearchParams(flags)}`;
  const response = await fetch(url, init);
  const { headers, ok } = response;

  if (!ok) {
    return response;
  }

  let maxDepth = Number(flags["max-depth"] || (flags.recursive ? Infinity : 1));
  if (!flags.recursive) {
    maxDepth = 1;
  }

  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("["));

      const links = getLinks(headers);
      let count = 0;

      while (maxDepth > 0) {
        const nextLinks = [];

        for await (let link of links) {
          const url = `${location}/${link}?${new URLSearchParams(flags)}`;
          const { headers } = await fetch(url, init);
          const size = Number(headers.get("Content-Length"));
          const IsDir = link.endsWith("/");
          if (IsDir) {
            nextLinks.push(...getLinks(headers, link));
            link = link.slice(0, -1);
          }

          const item: Partial<File> = {
            Path: `${link}`,
            Name: basename(link),
            Size: IsDir ? -1 : size,
            MimeType: IsDir ? "inode/directory" : headers.get("Content-Type") || "",
            ModTime: toLocaleISOString(headers.get("Last-Modified")),
            IsDir,
          }

          const prefix = count == 0 ? "\n" : ",\n";
          count++;

          controller.enqueue(encoder.encode(prefix + JSON.stringify(item)));
        }

        if (!nextLinks.length) {
          break;
        }

        links.length = 0;
        links.push(...nextLinks);
        maxDepth--;
      }

      controller.enqueue(encoder.encode("\n]\n"));
    }
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function getLinks(headers: Headers, parent = "") {
  return headers.get("Link")?.split(",").map((link) => {
    const [_, uri] = link.match(/<(.*)>/) || [];
    return decodeURIComponent(join(parent, uri));
  }) || [];
}

/**
 * List directories and objects in remote:path formatted for parsing.
 *
 * List the contents of the source path (directories and objects) in a form
 * which is easy to parse by scripts. By default this will just be the names of
 * the objects and directories, one per line. The directories will have a `/`
 * suffix.
 *
 * Example
 *
 * ```ts
 * import { Rclone } from "./mod.ts";
 * const response = await Rclone.lsf("remote:path");
 * console.log(await response.text());
 * // bevajer5jef
 * // canole
 * // diwogej7
 * // ferejej3gux/
 * // fubuwic
 * ```
 *
 * Use the `--format` option to control what gets listed. By default this is
 * just the path, but you can use these parameters to control the output:
 *
 * ```
 * p - path
 * s - size
 * t - modification time
 * h - hash
 * i - ID of object
 * o - Original ID of underlying object
 * m - MimeType of object if known
 * e - encrypted name
 * T - tier of storage if known, e.g. "Hot" or "Cool"
 * M - Metadata of object in JSON blob format, eg {"key":"value"}
 * ```
 *
 * So if you wanted the path, size and modification time, you would use
 * `--format "pst"`, or maybe `--format "tsp"` to put the path last.
 *
 * Example:
 *
 * ```ts
 * import { Rclone } from "./mod.ts";
 * const response = await Rclone.lsf("remote:path", { format: "tsp" });
 * console.log(await response.text());
 * // 2016-06-25 18:55:41;60295;bevajer5jef
 * // 2016-06-25 18:55:43;90613;canole
 * // 2016-06-25 18:55:43;94467;diwogej7
 * // 2018-04-26 08:50:45;0;ferejej3gux/
 * // 2016-06-25 18:55:40;37600;fubuwic
 * ```
 *
 * By default the separator is ";" this can be changed with the `--separator`
 * flag. Note that separators aren't escaped in the path so putting it last is
 * a good strategy.
 *
 * Example:
 *
 * ```ts
 * import { Rclone } from "./mod.ts";
 * const response = await Rclone.lsf("remote:path", {
 *   separator: ",",
 *   format: "tshp",
 * });
 * console.log(await response.text());
 * // 2016-06-25 18:55:41,60295,7908e352297f0f530b84a756f188baa3,bevajer5jef
 * // 2016-06-25 18:55:43,90613,cd65ac234e6fea5925974a51cdd865cc,canole
 * // 2016-06-25 18:55:43,94467,03b5341b4f234b9d984d03ad076bae91,diwogej7
 * // 2018-04-26 08:52:53,0,,ferejej3gux/
 * // 2016-06-25 18:55:40,37600,8fd37c3810dd660778137ac3a66cc06d,fubuwic
 *
 * You can output in CSV standard format. This will escape things in `"` if
 * they contain `,`.
 *
 * Example:
 *
 * ```ts
 * import { Rclone } from "./mod.ts";
 * const response = await Rclone.lsf("remote:path", {
 *   csv: true,
 *   "files-only": true,
 *   format: "ps",
 * });
 * console.log(await response.text());
 * // test.log,22355
 * // test.sh,449
 * // "this file contains a comma, in the file name.txt",6
 * ```
 *
 */
export async function lsf(location: string, flags: Options = {}): Promise<Response> {
  const {
    csv = false,
    "dir-slash": dirSlash = true,
    "dirs-only": dirOnly = false,
    "files-only": filesOnly = false,
    format = "p",
    separator = ";",
  } = flags;

  const response = await lsjson(location, flags);
  const { headers, ok } = response;

  if (!ok) {
    return response;
  }

  const body = response.body!
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TransformStream({
      transform(chunk, controller) {
        // `lsjson returns each item on a new line, and except the first line,
        // all lines start with a comma. We strip that leading comma and then
        // trim for any new lines.
        if (chunk.startsWith(",")) {
          chunk = chunk.substring(1);
        }
        chunk = chunk.trim();

        if (chunk.startsWith("{") && chunk.at(-1) === "}") {
          const item = JSON.parse(chunk) as File;
          if (dirOnly && !item.IsDir) return;
          if (filesOnly && item.IsDir) return;

          if (item.IsDir && dirSlash) {
            item.Name += "/";
          }

          chunk = [...format].map(f => {
            let value = item[FORMATS[f]];
            if (csv && typeof value === "string" && value.includes(",")) {
              value = `"${value}"`;
            }
            return value;
          }).join(separator);
          controller.enqueue(`${chunk}\n`);
        }
      }
    })
  )
  .pipeThrough(new TextEncoderStream());

  return new Response(body, {
    headers: {
      ...headers,
      "Content-Type": "text/plain",
    },
  });
}

/**
 * List the objects in the path with size and path.
 */
export function ls(location: string, flags: Options = {}): Promise<Response> {
  flags = {
    recursive: "true",
    "max-depth": "Infinity",
    "files-only": "true",
    format: "sp",
    separator: "\t",
    ...flags,
  }
  return lsf(location, flags);
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
  lsf,
  ls,
  cat,
  rcat,
  copy,
};

if (import.meta.main) {
  const { parseFlags } = await import("./deps.ts");

  /** All optional params for the command as an object. */
  const options: Options = {};

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
