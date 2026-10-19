/**
 * The folder in `cmd` of each command. The command line loads only the
 * module of its command: the load of all the commands takes much time.
 */
export const FOLDERS = {
  backend: "backend",
  cat: "cat",
  config: "config",
  copy: "copy",
  copyurl: "copyurl",
  help: "help",
  ls: "ls",
  lsd: "lsd",
  lsf: "lsf",
  lsjson: "lsjson",
  lsl: "lsl",
  obscure: "obscure",
  rcat: "rcat",
  reveal: "obscure",
  serve: "serve",
};

/**
 * The places of the paths of rclone in the arguments of each command, for
 * example 0 and 1 for `copy SOURCE TARGET`. A command reads its paths as
 * locations for `fetch`, with percent-encoding: the command line gives
 * them with `encodeLocation`. The URL of `copyurl` is not a path of rclone.
 * @type {Record<string, number[]>}
 */
export const PATHS = {
  backend: [1],
  cat: [0],
  copy: [0, 1],
  copyurl: [1],
  ls: [0],
  lsd: [0],
  lsf: [0],
  lsjson: [0],
  lsl: [0],
  rcat: [0],
  serve: [1],
};
