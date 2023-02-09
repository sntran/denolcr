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

import * as commands from "./cmd/main.ts";
import * as backends from "./backend/main.ts";

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
      const shortKey = key.slice(7).toLowerCase();
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
      const shortKey = key.slice(envPrefix.length).toLowerCase();
      params.set(shortKey, value);

      // Deletes any params that are already set by environment vars.
      params.delete(`${type}_${shortKey}`);
    }
  }

  // Overrides with remote specific environment vars
  envPrefix = `RCLONE_CONFIG_${name.toUpperCase()}_`;
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(envPrefix)) {
      const shortKey = key.slice(envPrefix.length).toLowerCase();
      params.set(shortKey, value);

      // Deletes any params that are already set by environment vars.
      params.delete(`config_${name}_${shortKey}`);
    }
  }

  // `searchParams` may contain other flags not for the current backend.
  const { pathname, searchParams } = new URL(path, "file:");

  // Overrides with flags in request's search params.
  searchParams.forEach((value, key) => {
    if (key.startsWith(`${type}_`)) {
      params.set(key.replace(`${type}_`, ""), value);
    }
  });

  // Overrides with parameters in connection string.
  args.forEach((arg) => {
    const [key, value = "true"] = arg.split("=");
    params.set(key, value);
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

  const { fetch } = backends[type as keyof typeof backends];

  const url = new URL(`${pathname}?${params}`, import.meta.url);
  // Creates a new request with the initial init.
  const request = new Request(url, init);
  // Clones that request and updates the headers.
  return fetch(new Request(request, {
    headers,
  }));
}

globalThis.fetch = fetch;

// @TODO: Type `Rclone` as `API`.
export const Rclone = {
  ...commands,
};

if (import.meta.main) {
  const { parseFlags } = await import("./deps.ts");

  /** All optional params for the command as an object. */
  const options: Options = {};

  const {
    _: [command, ...args],
    ..._globalFlags
    // @ts-ignore - Deno.args is not typed.
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
        options[key.replace(/-/g, "_")] = `${value}`;
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
