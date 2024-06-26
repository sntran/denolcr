import { fetch } from "../../main.js";

/**
 * @param {string} location
 * @param {Object} [flags]
 * @returns {Promise<Response>}
 */
export function cat(location, flags) {
  return fetch(location, flags);
}
