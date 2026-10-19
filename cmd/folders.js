/**
 * The folder in `cmd` of each command. The command line loads only the
 * module of its command: the load of all the commands takes much time.
 */
export const FOLDERS = {
  backend: "backend",
  cat: "cat",
  check: "check",
  checksum: "check",
  config: "config",
  copy: "copy",
  copyto: "copy",
  copyurl: "copyurl",
  cryptcheck: "check",
  cryptdecode: "cryptdecode",
  delete: "delete",
  deletefile: "delete",
  hashsum: "hashsum",
  help: "help",
  listremotes: "listremotes",
  ls: "ls",
  lsd: "lsd",
  lsf: "lsf",
  lsjson: "lsjson",
  lsl: "lsl",
  md5sum: "hashsum",
  mkdir: "mkdir",
  move: "move",
  moveto: "move",
  obscure: "obscure",
  purge: "delete",
  rcat: "rcat",
  reveal: "obscure",
  rmdir: "delete",
  rmdirs: "delete",
  serve: "serve",
  sha1sum: "hashsum",
  size: "size",
  touch: "touch",
  tree: "tree",
  version: "version",
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
  check: [0, 1],
  checksum: [1, 2],
  copy: [0, 1],
  copyto: [0, 1],
  copyurl: [1],
  cryptcheck: [0, 1],
  cryptdecode: [0],
  delete: [0],
  deletefile: [0],
  hashsum: [1],
  ls: [0],
  lsd: [0],
  lsf: [0],
  lsjson: [0],
  lsl: [0],
  md5sum: [0],
  mkdir: [0],
  move: [0, 1],
  moveto: [0, 1],
  purge: [0],
  rcat: [0],
  rmdir: [0],
  rmdirs: [0],
  serve: [1],
  sha1sum: [0],
  size: [0],
  touch: [0],
  tree: [0],
};
