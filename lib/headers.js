/**
 * The option `headers` of rclone, for the backends that send requests to a
 * server, for example `http` and `webdav`.
 */
import { parseList } from "./list.js";

/**
 * Reads the option `headers` of rclone: a list of names and values with
 * commas, for example `Cookie,name=value,Authorization,"Basic a2V5"`.
 * @param {string} text
 * @returns {Headers}
 * @throws {SyntaxError | TypeError} When the list is not correct, or when a
 *   name or a value is not correct for HTTP.
 */
export function parseHeaders(text) {
  const list = parseList(text);
  if (list.length % 2 !== 0) {
    throw new SyntaxError("odd number of headers supplied");
  }
  const headers = new Headers();
  for (let index = 0; index < list.length; index += 2) {
    headers.append(list[index], list[index + 1]);
  }
  return headers;
}
