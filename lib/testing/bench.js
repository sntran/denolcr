/**
 * A small benchmark for the scripts `*_bench.js`, in place of `Deno.bench`.
 * Run a script with `node FILE`.
 *
 * Each case is a function that gets a timer. By default the time of a run is
 * the time of the whole function. A case can call `timer.start()` and
 * `timer.end()` to time only a part, for example to leave out the start of a
 * process.
 */

/**
 * @typedef {Object} Timer
 * @property {() => void} start
 * @property {() => void} end
 */

/**
 * Runs each case of the group one time to warm up, then `runs` times, and
 * prints the mean time of a run.
 * @param {string} group
 * @param {Record<string, (timer: Timer) => Promise<void>>} cases
 * @param {{ runs?: number }} [options]
 */
export async function bench(group, cases, { runs = 10 } = {}) {
  console.log(group);
  for (const [name, run] of Object.entries(cases)) {
    await time(run);
    let total = 0;
    for (let i = 0; i < runs; i++) {
      total += await time(run);
    }
    console.log(`  ${name}: ${(total / runs).toFixed(1)} ms`);
  }
}

/**
 * Gives the time of one run, in milliseconds.
 * @param {(timer: Timer) => Promise<void>} run
 * @returns {Promise<number>}
 */
async function time(run) {
  let start, end;
  const timer = {
    start: () => (start = performance.now()),
    end: () => (end = performance.now()),
  };
  const before = performance.now();
  await run(timer);
  const after = performance.now();
  return (end ?? after) - (start ?? before);
}
