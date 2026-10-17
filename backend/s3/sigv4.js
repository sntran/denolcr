/**
 * The Signature Version 4 of AWS for S3: the header `Authorization` of a
 * request, from the method, the path, the query, the headers and the hash of
 * the body.
 */
import { createHash, createHmac } from "node:crypto";

/** The hash of a body that the signature does not cover. */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** The hash of an empty body. */
export const EMPTY_PAYLOAD =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Puts the percent-encoding of AWS in a text: all the bytes except
 * `A-Z a-z 0-9 - . _ ~`, and also `/` when `slash` is false.
 * @param {string} text
 * @param {boolean} [slash] True to keep `/`, for a path.
 * @returns {string}
 */
export function uriEncode(text, slash = false) {
  const encoded = encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return slash ? encoded.replaceAll("%2F", "/") : encoded;
}

/**
 * Signs a request.
 * @param {Object} request
 * @param {string} request.method
 * @param {URL} request.url The path of the URL has the percent-encoding of
 *   `uriEncode`. The query is any.
 * @param {Headers} request.headers The headers to sign. They get
 *   `x-amz-date`, `x-amz-content-sha256`, `x-amz-security-token` for a
 *   session token, and `Authorization`.
 * @param {string} [request.payload] The SHA-256 of the body in hexadecimal,
 *   or `UNSIGNED-PAYLOAD`.
 * @param {Object} credentials
 * @param {string} credentials.accessKeyId
 * @param {string} credentials.secretAccessKey
 * @param {string} [credentials.sessionToken]
 * @param {string} credentials.region
 * @param {string} [credentials.service]
 * @param {Date} [now]
 * @returns {Headers} The headers of the request.
 */
export function sign(
  { method, url, headers, payload = EMPTY_PAYLOAD },
  { accessKeyId, secretAccessKey, sessionToken, region, service = "s3" },
  now = new Date(),
) {
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  headers = new Headers(headers);
  headers.set("host", url.host);
  headers.set("x-amz-date", amzDate);
  headers.set("x-amz-content-sha256", payload);
  if (sessionToken) headers.set("x-amz-security-token", sessionToken);

  // The query, sorted by the names and the values, with the encoding of AWS.
  const query = [...url.searchParams]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)])
    .sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : +(x > y))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const names = [...headers.keys()].sort();
  const canonical = [
    method,
    url.pathname,
    query,
    ...names.map((name) =>
      `${name}:${headers.get(name).trim().replace(/\s+/g, " ")}`
    ),
    "",
    names.join(";"),
    payload,
  ].join("\n");

  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");

  let key = hmac(`AWS4${secretAccessKey}`, date);
  for (const part of [region, service, "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign).digest("hex");

  headers.set(
    "Authorization",
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${names.join(";")}, Signature=${signature}`,
  );
  // The host of the URL goes in the request.
  headers.delete("host");
  return headers;
}

/** @param {string | Buffer} key @param {string} data */
function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}
