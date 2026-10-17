/**
 * Benchmark of the `lsjson` command against `rclone lsjson`.
 *
 * `rclone` must be in the PATH. Run with `node cmd/lsjson/main_bench.js`.
 *
 * This benchmark leaves out the time to start the `rclone` process, for a
 * more accurate comparison.
 */
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { bench } from "../../lib/bench.js";
import { lsjson } from "./main.js";

const remotes = ["./", "./backend/", "./cmd/"];

for (const remote of remotes) {
  await bench(`timing ${remote} --recursive`, {
    [`rfetch lsjson ${remote} --recursive`]: async () => {
      const response = await lsjson(remote, { recursive: true });
      await response.arrayBuffer();
    },
    [`rclone lsjson ${remote} --recursive`]: async (timer) => {
      const rclone = spawn("rclone", ["lsjson", remote, "--recursive"], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      timer.start();
      await new Response(Readable.toWeb(rclone.stdout)).arrayBuffer();
      timer.end();
    },
  });
}
