import { fetch, Options } from "../../main.ts";

export function cat(location: string, flags?: Options): Promise<Response> {
  return fetch(location, flags);
}
