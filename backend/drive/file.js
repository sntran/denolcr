const BASE_URL = "https://www.googleapis.com/drive/v3/files";

// https://developers.google.com/drive/api/reference/rest/v3/files#File
/**
 * A Google Drive file.
 * @typedef {Object} File
 * @property {string} [fileExtension]
 * @property {string} [md5Checksum]
 * @property {ContentHints} [contentHints]
 * @property {string} mimeType
 * @property {string[]} parents
 * @property {string} [thumbnailLink]
 * @property {number} [size]
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {string} [createdTime]
 * @property {string} [modifiedTime]
 * @property {string} [originalFilename]
 * @property {string} [fullFileExtension]
 * @property {Object} [properties]
 * @property {string} [teamDriveId]
 */

/**
 * @typedef {Object} ContentHints
 * @property {string} indexableText
 * @property {Object} thumbnail
 * @property {string} thumbnail.image
 * @property {string} thumbnail.mimeType
 */

const globalFetch = globalThis.fetch;

/**
 * Requests a file by ID.
 * @param {string | URL | Request} input
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
export function fetch(input, init) {
  if (typeof input === "string") {
    input = new URL(input, "drive:/");
  }

  if (input instanceof URL) {
    input = new Request(input);
  }

  input = new Request(input, init);

  const { pathname } = new URL(input.url);
  const url = new URL(`${BASE_URL}${pathname}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("acknowledgeAbuse", "true");

  return globalFetch(url, input);
}
