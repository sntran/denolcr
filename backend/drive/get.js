const BASE_URL = "https://www.googleapis.com/drive/v3/files";

/**
 * Gets a file by ID.
 * @param {string | URL | Request} input
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
export function get(input, init) {
  if (typeof input === "string") {
    input = new URL(input, "drive:/");
  }

  if (input instanceof URL) {
    input = new Request(input);
  }

  input = new Request(input, init);

  const headers = input.headers;
  const { pathname } = new URL(input.url);
  const url = new URL(`${BASE_URL}${pathname}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("acknowledgeAbuse", "true");

  return fetch(url, { headers });
}
