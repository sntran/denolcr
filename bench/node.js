/**
 * Runs the cases of the benchmark in Node.js: `node bench/node.js`.
 *
 * Each case runs in a new process, as a command of rfetch does: the time of
 * a case can change much with the work before it in the same process.
 * `node bench/node.js NAME` runs only the case NAME.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bench } from "@rfetch/lib/testing/bench";
import { cases, setup } from "./cases.js";

const [name] = process.argv.slice(2);

if (name) {
  await setup();
  await bench("", { [name]: cases[name] }, { runs: 5 });
} else {
  console.log("rfetch in Node.js");
  for (const name of Object.keys(cases)) {
    const output = execFileSync(
      process.execPath,
      [fileURLToPath(import.meta.url), name],
      { encoding: "utf8" },
    );
    process.stdout.write(output.split("\n").slice(1).join("\n"));
  }
}
