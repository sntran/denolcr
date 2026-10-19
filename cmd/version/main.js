import process from "node:process";

import info from "../../package.json" with { type: "json" };

/**
 * Show the version number, as `rclone version`: the version of rfetch, and
 * the runtime, the system and the processor that run it.
 * @returns {Response}
 */
export function version() {
  const { versions } = process;
  const runtime = versions.bun
    ? `bun ${versions.bun}`
    : versions.deno
    ? `deno ${versions.deno}`
    : `node ${versions.node}`;
  return new Response(
    `rfetch v${info.version}\n` +
      `- os/type: ${process.platform}\n` +
      `- os/arch: ${process.arch}\n` +
      `- runtime: ${runtime}\n`,
  );
}
