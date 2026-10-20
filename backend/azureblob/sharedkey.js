/**
 * The Shared Key authorization of Azure Storage for the Blob service: the
 * header `Authorization` of a request, from the method, the headers, the
 * path and the query, as "Authorize with Shared Key" of Azure.
 */
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";

/** The standard headers in the text to sign, in their order. */
const STANDARD = [
  "Content-Encoding",
  "Content-Language",
  "Content-Length",
  "Content-MD5",
  "Content-Type",
  "Date",
  "If-Modified-Since",
  "If-Match",
  "If-None-Match",
  "If-Unmodified-Since",
  "Range",
];

/**
 * Signs a request with the key of a storage account.
 * @param {Object} request
 * @param {string} request.method
 * @param {URL} request.url The path has the percent-encoding of the request.
 * @param {Headers} request.headers The headers of the request. They must
 *   have `x-ms-version`.
 * @param {Object} credentials
 * @param {string} credentials.account The name of the storage account.
 * @param {string} credentials.key The key of the account, in base64.
 * @param {Date} [now]
 * @returns {Headers} The headers of the request, with `x-ms-date` and
 *   `Authorization`.
 */
export function sign(
  { method, url, headers },
  { account, key },
  now = new Date(),
) {
  headers = new Headers(headers);
  headers.set("x-ms-date", now.toUTCString());

  const standard = STANDARD.map((name) => {
    const value = headers.get(name) ?? "";
    // From version 2015-02-21, a length of 0 is an empty string.
    return name === "Content-Length" && value === "0" ? "" : value;
  });
  const canonicalHeaders = [...headers.keys()]
    .filter((name) => name.startsWith("x-ms-"))
    .sort()
    .map((name) => `${name}:${headers.get(name).replace(/\s+/g, " ").trim()}\n`)
    .join("");
  // The query, with no percent-encoding, by the names in lower case.
  /** @type {Map<string, string[]>} */
  const params = new Map();
  for (const [name, value] of url.searchParams) {
    const lower = name.toLowerCase();
    params.set(lower, [...(params.get(lower) ?? []), value]);
  }
  const canonicalQuery = [...params.keys()].sort()
    .map((name) => `\n${name}:${params.get(name).sort().join(",")}`)
    .join("");
  const toSign = [method, ...standard].join("\n") + "\n" + canonicalHeaders +
    `/${account}${url.pathname}${canonicalQuery}`;

  const signature = createHmac("sha256", Buffer.from(key, "base64"))
    .update(toSign, "utf8")
    .digest("base64");
  headers.set("Authorization", `SharedKey ${account}:${signature}`);
  return headers;
}
