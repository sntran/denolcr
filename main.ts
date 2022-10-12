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

export type Command = (
  ...args: string[],
  options?: Record<string, unknown>,
) => Response | Promise<Response>;

export type Remote = {
  type: string;
} & Record<string, string>;

export interface Backend {
  fetch(request: Request): Response | Promise<Response>;
}

export class Rclone {
  [name: string]: Command;

  #config;
  #flags;

  constructor(
    config: Record<string, Remote> = {},
    flags: Record<string, unknown> = {},
  ) {
    this.#config = config;
    this.#flags = flags;
  }

  /**
   * Fetches a location string with remote name and its path.
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
  async #fetch(location: string, init?: RequestInit): Promise<Response> {
    const [path, remote, backend] = location.split(":").reverse();
    let config: Remote;
    if (!remote) {
      config = { type: "local" };
    } else if (backend === "") { // The location has format `:type:path/to/file`.
      config = { type: remote };
    } else {
      config = this.#config[remote];
    }

    const { type, ...options } = config;

    const { fetch } = await import(`rclone/backend/${type}/main.ts`);
    /** @TODO: parse only flags for the current backend. */
    const url = new URL(
      `${path}?${new URLSearchParams(options)}`,
      import.meta.url,
    );
    const request = new Request(url, init);
    return fetch(request);
  }

  async lsjson(
    location: string,
    _options: Record<string, unknown> = {},
  ): Promise<Response> {
    const init = { method: "HEAD" };
    const { headers } = await this.#fetch(location, init);

    const links = headers.get("Link")?.split(",").map((link) => {
      const [_, uri] = link.match(/<(.*)>/) || [];
      return uri;
    }) || [];

    const files = [];

    for await (const link of links) {
      const { headers } = await this.#fetch(link, init);
      const size = Number(headers.get("Content-Length"));
      files.push({
        IsDir: size === 0,
        MimeType: headers.get("Content-Type"),
        ModTime: headers.get("Last-Modified"),
        Name: link,
        Path: `${location}/${link}`,
        Size: size,
      });
    }

    return Response.json(files);
  }

  cat(
    location: string,
    _options: Record<string, unknown> = {},
  ): Promise<Response> {
    return this.#fetch(location);
  }

  rcat(destination: string): Promise<Response> {
    return this.#fetch(destination, {
      method: "PUT",
      body: Deno.stdin.readable,
    });
  }

  async copy(
    source: string,
    target: string,
    options: Record<string, unknown> = {},
  ): Promise<Response> {
    /** @TODO: Handle copy folder */
    const { body } = await this.#fetch(source);
    return this.#fetch(target, { method: "PUT", body });
  }
}

if (import.meta.main) {
  const { parseFlags } = await import("./deps.ts");

  /** All optional params for the command as an object. */
  const options: Record<string, unknown> = {};
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
    ],
    collect: [
      "header",
      "header-download",
      "header-upload",
    ],
    default: {},
    /** Collects other optional params */
    unknown: (_arg: string, key?: string, value?: unknown) => {
      if (key) { // key is the flag name
        options[key] = value;
        return false;
      }
    },
  });

  const rclone = new Rclone({}, globalFlags);
  const response = await rclone[command](...args, options);
  response.body?.pipeTo(Deno.stdout.writable);
}
