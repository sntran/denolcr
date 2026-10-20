/**
 * Reads a file `known_hosts` of OpenSSH, as the option `known_hosts_file`
 * of rclone, and finds the host key of a server in it.
 */

import { equalBytes } from "./ssh/wire.js";
import { fromBase64 } from "./ssh/keys.js";

/**
 * The name of a host in a file `known_hosts`: the host for the port 22,
 * else `[host]:port`.
 * @param {string} host
 * @param {number} port
 */
function nameOf(host, port) {
  return port === 22 ? host : `[${host}]:${port}`;
}

/**
 * Tells if a pattern of OpenSSH matches a name: `*` is any text, and `?`
 * is one character.
 * @param {string} pattern
 * @param {string} name
 */
function matches(pattern, name) {
  const source = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(name.toLowerCase());
}

/**
 * Tells if a hashed name, `|1|salt|hash`, is the name: the hash is the
 * HMAC-SHA1 of the name with the salt as its key.
 * @param {string} entry
 * @param {string} name
 */
async function matchesHash(entry, name) {
  const [, , salt, hash] = entry.split("|");
  if (!salt || !hash) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(salt),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(name)),
  );
  return equalBytes(mac, fromBase64(hash));
}

/**
 * Tells if the hosts of a line match the name of a server, as OpenSSH: a
 * pattern with `!` before it excludes the name.
 * @param {string} hosts The hosts of the line, with `,` between them.
 * @param {string} name
 */
async function hostMatches(hosts, name) {
  let found = false;
  for (const pattern of hosts.split(",")) {
    if (pattern.startsWith("|1|")) {
      if (await matchesHash(pattern, name)) found = true;
    } else if (pattern.startsWith("!")) {
      if (matches(pattern.slice(1), name)) return false;
    } else if (matches(pattern, name)) {
      found = true;
    }
  }
  return found;
}

/**
 * Finds the host key of a server in a file `known_hosts`.
 * @param {string} text The content of the file.
 * @param {string} host
 * @param {number} port
 * @param {Uint8Array} blob The host key of the server.
 * @returns {Promise<"known" | "unknown" | "changed" | "revoked">} `known`
 *   when the file has the key for the host, `changed` when the file has
 *   other keys for the host, `revoked` when the file revokes the key.
 */
export async function findHostKey(text, host, port, blob) {
  const name = nameOf(host, port);
  let other = false;
  let known = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    let marker = "";
    if (fields[0].startsWith("@")) marker = fields.shift() ?? "";
    const [hosts, , key] = fields;
    if (!hosts || !key) continue;
    let keyBlob;
    try {
      keyBlob = fromBase64(key);
    } catch {
      continue;
    }
    const same = equalBytes(keyBlob, blob);
    // A revoked key is refused for each host.
    if (marker === "@revoked") {
      if (same) return "revoked";
      continue;
    }
    // rfetch does not know the certificates of hosts.
    if (marker !== "") continue;
    if (!await hostMatches(hosts, name)) continue;
    if (same) known = true;
    else other = true;
  }
  if (known) return "known";
  return other ? "changed" : "unknown";
}
