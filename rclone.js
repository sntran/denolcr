// deno-lint-ignore-file no-var
// Copyright 2018-2021 Trần Nguyễn Sơn. All rights reserved. MIT license.
/**
 * Deno wrapper for rclone using WebAssembly build.
 *
 * @example
 * ```ts
 * import { Rclone } from "https://deno.land/x/rclone/rclone.js";
 *
 * const rclone = new Rclone();
 * rclone.rc("core/version");
 * ```
 *
 * By default, provided [rclone.wasm](https://deno.land/x/rclone/rclone.wasm)
 * module is used. This can be changed by providing another compiled module in
 * the constructor.
 *
 * @example
 * ```ts
 * import { Rclone } from "https://deno.land/x/rclone/rclone.js";
 *
 * const module = await WebAssembly.compileStreaming(fetch("https://deno.land/x/rclone/rclone.wasm"));
 * const rclone = new Rclone(module);
 *
 * rclone.rc("core/version");
 * ```
 *
 * The default module provides the following backends:
 *
 * - alias
 * - chunker
 * - crypt
 * - ftp
 * - http
 * - memory
 * - union
 */
import "https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/js/wasm_exec.js";

/** Provides a default WASM module. */
const wasm = await WebAssembly.compileStreaming(
  fetch(new URL("./rclone.wasm", import.meta.url)),
);

const CONNECTION_STRING = /(.+:)([^:]*)$/;

/** A Rclone instance from a compiled WebAssemble module. */
export class Rclone extends WebAssembly.Instance {
  /**
   * Create a rclone instance.
   * @param {WebAssembly.Module} module - Rclone's WASM module
   */
  constructor(module = wasm) {
    // Patches for rclone.
    globalThis.document ??= {};
    globalThis.rcValidResolve ??= function () {
      // Invoked by rclone at the end of initialization.
    };
    // Instantiates WASM module.
    const go = new Go(); // From `wasm_exec.js`

    super(module, go.importObject);

    go.run(this);
  }

  /**
   * Returns the space used on the remote
   * @param {string} fs a remote name string e.g. "drive:"
   * @returns {Object} as returned from `rclone about --json`
   */
  about(fs) {
    return this.rc("operations/about", { fs });
  }

  /**
   * Runs a backend command
   * @param {string} command Command name
   * @param {string} fs a remote name string e.g. "drive:"
   * @param {Object} args a list of arguments for the backend command
   * @returns 
   */
  backend(command, fs, args = {}) {
    return this.rc("backend/command", { command, fs, ...args});
  }

  /**
   * Checks the files in the source and destination match
   * @param {string} srcFs a remote name string e.g. "drive:" for the source
   * @param {string} dstFs a remote name string e.g. "drive2:" for the destination
   * @param {Object} args arguments similar to ones from `rclone check`
   * @returns a report of files that don't match
   */
  check(srcFs, dstFs, args = {}) {
    return this.rc("operations/check", { srcFs, dstFs, ...args });
  }

  /**
   * Removes trashed files in the remote or path
   * @param {string} fs 
   * @returns 
   */
  cleanup(fs) {
    return this.rc("operations/cleanup", { fs });
  }

  /**
   * Copies a directory from source remote to destination remote
   * @param {string} srcFs a remote name string e.g. "drive:src" for the source
   * @param {string} dstFs a remote name string e.g. "drive:dst" for the destination
   * @returns 
   */
  copy(srcFs, dstFs, options = {}) {
    return this.rc("sync/copy", { srcFs, dstFs, ...options });
  }

  /**
   * Copies a file from source remote to destination remote
   * @param {string} src a source path string e.g. "drive:path/to/file"
   * @param {string} dst a destination path string e.g. "drive:path/to/file"
   * @returns 
   */
  copyto(src, dst) {
    const [, srcFs, srcRemote] = src.match(CONNECTION_STRING);
    const [, dstFs, dstRemote] = dst.match(CONNECTION_STRING);
    return this.rc("operations/copyfile", {
      srcFs, srcRemote,
      dstFs, dstRemote,
    });
  }

  /**
   * Copies the URL to the object
   * @param {string|URL} url 
   * @param {string} dst a remote path string e.g. "drive:path/to/file"
   * @returns 
   */
  copyurl(url, dst, options = {}) {
    const [, fs, remote ] = dst.match(CONNECTION_STRING);
    return this.rc("operations/copyurl", { url, fs, remote, ...options });
  }

  /**
   * Removes files in the path
   * @param {string} fs a remote name string e.g. "drive:"
   * @returns 
   */
  delete(fs) {
    return this.rc("operations/delete", { fs });
  }
  
  /**
   * Removes a single file
   * @param {string} src a remote path string e.g. "drive:path/to/file"
   * @returns 
   */
  deletefile(src) {
    const [, fs, remote ] = src.match(CONNECTION_STRING);
    return this.rc("operations/deletefile", { fs, remote });
  }

  /**
   * Produces a hashsum file for all the objects in the path.
   * @param {string} fs 
   * @returns 
   */
  hashsum(fs, options = {}) {
    return this.rc("operations/hashsum", { fs, ...options });
  }

  /**
   * Creates or retrieves a public link to the given file or folder.
   * @param {string} target a remote path string e.g. "drive:path/to/file"
   * @param {Object} options 
   * @returns 
   */
  link(target, options = {}) {
    const [, fs, remote ] = target.match(CONNECTION_STRING);
    return this.rc("operations/publiclink", { fs, remote, ...options });
  }

  /**
   * Lists the given remote and path in JSON format
   * @param {string} src 
   * @returns 
   */
  lsjson(src, options = {}) {
    const [, fs, remote ] = src.match(CONNECTION_STRING);
    return this.rc("operations/list", { fs, remote, opt: options });
  }

  /**
   * Makes a destination directory
   * @param {string} dst 
   * @returns 
   */
  mkdir(dst) {
    const [, fs, remote ] = dst.match(CONNECTION_STRING);
    return this.rc("operations/mkdir", { fs, remote });
  }

  /**
   * Moves a directory from source remote to destination remote
   * @param {string} srcFs a remote name string e.g. "drive:src" for the source
   * @param {string} dstFs a remote name string e.g. "drive:dst" for the destination
   * @returns 
   */
  move(srcFs, dstFs, options = {}) {
    return this.rc("sync/move", { srcFs, dstFs, ...options });
  }

  noop(args = {}) {
    return this.rc("rc/noop", args);
  }

  obscure(password) {
    return this.rc("core/obscure", { clear: password }).obscured;
  }
  
  /**
   * Removes a directory or container and all of its contents
   * @param {string} dst
   * @returns 
   */
  purge(dst) {
    const [, fs, remote ] = dst.match(CONNECTION_STRING);
    return this.rc("operations/purge", { fs, remote });
  }

  /**
   * Removes an empty directory or container
   * @param {string} dst 
   * @returns 
   */
  rmdir(dst) {
    const [, fs, remote ] = dst.match(CONNECTION_STRING);
    return this.rc("operations/rmdir", { fs, remote });
  }

  /**
   * Removes all the empty directories in the path
   * @param {string} dst 
   * @returns 
   */
  rmdirs(dst, options = {}) {
    const [, fs, remote ] = dst.match(CONNECTION_STRING);
    return this.rc("operations/rmdirs", { fs, remote, ...options });
  }

  /**
   * Changes storage tier or class on all files in the path
   * @param {string} fs a remote name string e.g. "drive:"
   * @returns 
   */
  settier(fs) {
    return this.rc("operations/settier", { fs });
  }

  /**
   * Changes storage tier or class on all files in the path
   * @param {string} dst a remote name string e.g. "drive:path/to/dir"
   * @returns 
   */
  settierfile(dst) {
    const [, fs, remote ] = dst.match(CONNECTION_STRING);
    return this.rc("operations/settierfile", { fs, remote });
  }

  /**
   * Count the number of bytes and files in remote
   * @param {string} fs aa remote name string e.g. "drive:path/to/dir"
   * @returns 
   */
  size(fs) {
    return this.rc("operations/size", { fs });
  }

  /**
   * Syncs a directory from source remote to destination remote
   * @param {string} srcFs a remote name string e.g. "drive:src" for the source
   * @param {string} dstFs a remote name string e.g. "drive:dst" for the destination
   * @returns 
   */
  sync(srcFs, dstFs, options = {}) {
    return this.rc("sync/sync", { srcFs, dstFs, ...options });
  }

  /** Remote controls rclone
   * 
   * @param {string} command
   * @param {Object|null} args
   *
   * ```ts
   * import { Rclone } from "./rclone.ts";
   * const { rc } = new Rclone();
   * console.log("core/version", rc("core/version", null))
   * console.log("rc/noop", rc("rc/noop", {"string":"one",number:2}))
   * console.log("operations/mkdir", rc("operations/mkdir", {"fs":":memory:","remote":"bucket"}))
   * console.log("operations/list", rc("operations/list", {"fs":":memory:","remote":"bucket"}))
   * ```
   */
  rc(command, args) {
    return globalThis.rc(command, args);
  }
}

// Learn more at https://deno.land/manual/examples/module_metadata#concepts
if (import.meta.main) {
  const { rc } = new Rclone();
  const [command, ...args] = Deno.args;
  const params = {};

  let argCount = args.length;
  while (argCount--) {
    const arg = args[argCount];
    if (arg.includes("=")) {
      const [key, value] = arg.split("=");
      if (isNaN(Number(value))) {
        params[key] = value;
      } else {
        params[key] = Number(value);
      }
      args.splice(argCount, 1);
    }
  }

  console.log(rc(command, params));
}
