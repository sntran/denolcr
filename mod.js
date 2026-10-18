// The import of fetch.js also sets the global `fetch`.
export { fetch } from "./fetch.js";
export * from "./cmd/main.js";

export { Progress } from "@rfetch/lib/progress";

/**
 * @typedef {Object<string, string>} Options
 */

/**
 * @typedef {(args: string[], options?: Options) => Promise<Response>} Command
 */

/**
 * @typedef {Options & { type: string }} Remote
 */

/**
 * File represents a file or directory.
 * @typedef {Object} File
 * @property {string} ID
 * @property {string} OrigID
 * @property {boolean} IsDir
 * @property {string} MimeType
 * @property {string} ModTime
 * @property {string} Name
 * @property {string} Encrypted
 * @property {string} EncryptedPath
 * @property {string} Path
 * @property {number} Size
 * @property {string} Tier
 * @property {Object} Metadata
 */
