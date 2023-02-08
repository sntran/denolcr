import { fetch, Options } from "../../main.ts";

export function rcat(destination: string, flags?: Options): Promise<Response> {
  return fetch(`${destination}?${new URLSearchParams(flags)}`, {
    method: "PUT",
    body: Deno.stdin.readable,
  });
}
