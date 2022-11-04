/**
 * Run a backend-specific command.
 *
 * This runs a backend-specific command. The commands themselves (except for
 * "help" and "features") are defined by the backends and you should see the
 * backend docs for definitions.
 */
export async function backend(
  command: string,
  remote: string,
  ...args: [...unknown[]]
): Promise<Response> {
  // The options is always passed as the last argument.
  const options = args.pop() as Record<string, string>;

  // TRACE the remote to retrive its type and configuration.
  const response = await fetch(remote, { method: "TRACE" });
  const [, type] = response.headers.get("Via")!.match(/^(.*?)(\/.*)?$/) || [];

  const body = await response.text();
  const [, url] = body.match(/^TRACE (.*) HTTP\/1.1$/m) ||
    [];
  const { searchParams } = new URL(url, "file:");

  // Retrieves all exported functions as commands.
  const exports = await import(`rclone/backend/${type}/main.ts`);

  // Fills the options with the remote's configuration.
  searchParams.forEach((value, key) => {
    if (!options[key]) {
      options[key] = value;
    }
  });

  return exports[command](options, ...args);
}
