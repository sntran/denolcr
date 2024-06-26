/**
 * Benchmark `lsjson` command vs `rclone lsjson` command.
 *
 * `rclone` must be installed and available in the PATH.
 *
 * This benchmark skips the time to spawn `rclone` process for more
 * accurate comparison.
 */

import { lsjson } from "./main.js";

const remotes = ["./", "./backend/", "./cmd/"];

for (const remote of remotes) {
  Deno.bench(
    `denolcr lsjson ${remote} --recursive`,
    {
      baseline: true,
      group: `timing ${remote} --recursive`,
      permissions: {
        env: true,
        read: true,
      },
    },
    async () => {
      const response = await lsjson(remote, { recursive: true });
      await response.arrayBuffer();
    },
  );

  Deno.bench(
    `rclone lsjson ${remote} --recursive`,
    {
      group: `timing ${remote} --recursive`,
      permissions: {
        env: true,
        read: true,
        run: true,
      },
    },
    async (b) => {
      const command = new Deno.Command("rclone", {
        args: [
          "lsjson",
          remote,
          "--recursive",
        ],
        stdout: "piped",
      });

      const process = command.spawn();

      b.start();

      const response = new Response(process.stdout);
      await response.arrayBuffer();

      b.end();
    },
  );
}
