/**
 * Runs the cases of the benchmark in a Worker:
 * `npx wrangler dev -c bench/wrangler.json`, then `curl http://localhost:8787/`.
 * The clock of `wrangler dev` moves during the work of a request, thus the
 * times are times of the CPU. A Worker in production has no such clock.
 */
import { cases, setup } from "./cases.js";

const RUNS = 5;

export default {
  async fetch() {
    await setup();
    let text = "rfetch in workerd\n";
    for (const [name, run] of Object.entries(cases)) {
      await run();
      const start = performance.now();
      for (let i = 0; i < RUNS; i++) await run();
      text += `  ${name}: ${
        ((performance.now() - start) / RUNS).toFixed(1)
      } ms\n`;
    }
    return new Response(text);
  },
};
