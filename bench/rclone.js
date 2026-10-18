/**
 * Compares the commands of rfetch with the commands of rclone:
 * `node bench/rclone.js`. rclone must be in the PATH, or in the variable
 * RCLONE.
 *
 * Each case runs the same command of each tool as a new process, with the
 * same remotes in the variables RCLONE_CONFIG_*, on the same files in a
 * temporary folder, which is the current folder of each process: the local
 * backend of rfetch reads only the files in its current folder. The time is
 * the time of the whole process, as a user
 * sees it: the start of Node.js or of rclone is in it. The first case, a
 * list of an empty folder, shows the time of the start.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RCLONE = process.env.RCLONE || "rclone";
const RFETCH = fileURLToPath(new URL("../main.js", import.meta.url));
const RUNS = 5;
/** The size of a large file. */
const SIZE = 64 * 1024 * 1024;

const root = mkdtempSync(join(tmpdir(), "rfetch-bench-"));
const home = join(root, "home");
mkdirSync(home);

/** The environment of each tool: the remotes, and no config file. */
const env = {
  PATH: process.env.PATH,
  HOME: home,
  RCLONE_CONFIG_SECRET_TYPE: "crypt",
  RCLONE_CONFIG_SECRET_REMOTE: "crypt",
  RCLONE_CONFIG_SECRET_PASSWORD: execFileSync(RCLONE, ["obscure", "bench"], {
    encoding: "utf8",
  }).trim(),
  RCLONE_CONFIG_CHUNKS_TYPE: "chunker",
  RCLONE_CONFIG_CHUNKS_REMOTE: "chunks",
  RCLONE_CONFIG_CHUNKS_CHUNK_SIZE: "8M",
};

/** The command of a tool, as a program and its arguments. */
const tools = {
  rfetch: (args) => [process.execPath, [RFETCH, ...args]],
  rclone: (args) => [RCLONE, args],
};

/**
 * Runs a command of a tool, and gives its time and the hash of its output.
 * @param {string} tool
 * @param {string[]} args
 * @param {string} [input] A file for the standard input.
 */
function run(tool, args, input) {
  const [program, argv] = tools[tool](args);
  const output = join(root, "output");
  const stdin = input ? openSync(input, "r") : "ignore";
  const stdout = openSync(output, "w");
  const start = performance.now();
  const result = spawnSync(program, argv, {
    cwd: root,
    env,
    stdio: [stdin, stdout, "pipe"],
  });
  const time = performance.now() - start;
  if (typeof stdin === "number") closeSync(stdin);
  closeSync(stdout);
  if (result.status !== 0) {
    throw new Error(`${tool} ${args.join(" ")}: ${result.stderr}`);
  }
  const hash = createHash("sha256").update(readFileSync(output)).digest("hex");
  return { time, hash };
}

/**
 * The lines of `lsjson` with no times, in order, for a compare. The size of
 * a folder is not in a line: rclone gives the size of a local folder, and
 * rfetch gives -1.
 */
function paths(tool, args) {
  run(tool, args);
  return JSON.parse(readFileSync(join(root, "output"), "utf8"))
    .map(({ Path, Size, IsDir }) => `${Path} ${IsDir ? "folder" : Size}`)
    .sort();
}

// The files of the cases.
const big = join(root, "big.bin");
writeFileSync(big, randomBytes(SIZE));
mkdirSync(join(root, "empty"));
for (let folder = 0; folder < 10; folder++) {
  mkdirSync(join(root, "tree", `folder ${folder}`), { recursive: true });
  for (let file = 0; file < 100; file++) {
    writeFileSync(
      join(root, "tree", `folder ${folder}`, `file ${file}.txt`),
      `${folder} ${file}`,
    );
  }
}
// rclone writes the files that both tools read from crypt and chunker.
const setup = { cwd: root, env, stdio: "ignore" };
execFileSync(RCLONE, ["copy", "tree", "secret:tree"], setup);
execFileSync(RCLONE, ["copyto", "big.bin", "secret:big.bin"], setup);
execFileSync(RCLONE, ["copyto", "big.bin", "chunks:big.bin"], setup);

/** @type {Record<string, (tool: string) => string[] | [string[], string]>} */
const cases = {
  "lsjson of an empty folder (start)": () => ["lsjson", "empty"],
  "local: cat 64 MiB": () => ["cat", "big.bin"],
  "local: lsjson --recursive, 1000 files": () => [
    "lsjson",
    "--recursive",
    "tree",
  ],
  "crypt: cat 64 MiB": () => ["cat", "secret:big.bin"],
  "crypt: rcat 64 MiB": (tool) => [["rcat", `secret:${tool}/put.bin`], big],
  "crypt: lsjson --recursive, 1000 files": () => [
    "lsjson",
    "--recursive",
    "secret:tree",
  ],
  "chunker: cat 64 MiB in chunks of 8 MiB": () => ["cat", "chunks:big.bin"],
  "chunker: rcat 64 MiB in chunks of 8 MiB": (tool) => [
    ["rcat", `chunks:${tool}/put.bin`],
    big,
  ],
};

try {
  // The two tools give the same data and the same lists.
  const hash = createHash("sha256").update(readFileSync(big)).digest("hex");
  for (const tool of Object.keys(tools)) {
    for (const location of ["secret:big.bin", "chunks:big.bin"]) {
      if (run(tool, ["cat", location]).hash !== hash) {
        throw new Error(`${tool} cat ${location}: not the same data`);
      }
    }
    for (const location of ["secret", "chunks"]) {
      run(tool, ["rcat", `${location}:${tool}/check.bin`], big);
      if (
        run("rclone", ["cat", `${location}:${tool}/check.bin`]).hash !== hash
      ) {
        throw new Error(`${tool} rcat ${location}: rclone reads other data`);
      }
    }
  }
  for (const location of ["tree", "secret:tree"]) {
    const args = ["lsjson", "--recursive", location];
    if (`${paths("rfetch", args)}` !== `${paths("rclone", args)}`) {
      throw new Error(`lsjson ${location}: not the same list`);
    }
  }

  console.log(
    `rfetch (Node.js ${process.versions.node}) and rclone, median of ${RUNS} runs`,
  );
  for (const [name, make] of Object.entries(cases)) {
    const times = {};
    for (const tool of Object.keys(tools)) {
      const made = make(tool);
      const [args, input] = Array.isArray(made[0]) ? made : [made];
      run(tool, args, input);
      const list = [];
      for (let i = 0; i < RUNS; i++) list.push(run(tool, args, input).time);
      times[tool] = list.sort((a, b) => a - b)[Math.floor(RUNS / 2)];
    }
    const ratio = (times.rfetch / times.rclone).toFixed(1);
    console.log(
      `  ${name}: rfetch ${times.rfetch.toFixed(0)} ms, rclone ${
        times.rclone.toFixed(0)
      } ms (${ratio}x)`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
