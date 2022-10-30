import { fetch, Options } from "rclone";

export function cat(location: string, flags?: Options): Promise<Response> {
  return fetch(location, flags);
}
