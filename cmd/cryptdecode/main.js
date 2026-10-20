import { nameCipher } from "@rfetch/crypt";
import { isTrue } from "@rfetch/lib/options";

import { failure, OperationError, remoteOf } from "../operations.js";

/**
 * Cryptdecode returns unencrypted file names, as `rclone cryptdecode`: a
 * line for each name, with the name, a tab and the decrypted name, or
 * `Failed to decrypt`. With `--reverse`, it encrypts the names.
 *
 * ```js
 * import { cryptdecode } from "./main.js";
 * await cryptdecode("encryptedremote:", "encryptedname1", {});
 * ```
 * @param {string} remote A crypt remote.
 * @param {...(string | Object)} args The names, then the flags.
 * @returns {Promise<Response>}
 */
export async function cryptdecode(remote, ...args) {
  const flags = typeof args.at(-1) === "object" ? args.pop() : {};
  try {
    const { type, options } = await remoteOf(remote, flags);
    if (type !== "crypt") {
      throw new OperationError(
        'the remote needs to be of type "crypt"',
        400,
      );
    }
    if (!options.password) throw new OperationError("Missing password", 400);
    let names;
    try {
      names = await nameCipher(options);
    } catch {
      throw new OperationError("The password is not obscured", 400);
    }
    const reverse = isTrue(flags.reverse);
    const lines = args.map((name) => {
      try {
        return reverse
          ? `${name} \t ${names.encrypt(name)}`
          : `${name} \t ${names.decrypt(name)}`;
      } catch {
        return `${name} \t Failed to ${reverse ? "encrypt" : "decrypt"}`;
      }
    });
    return new Response(lines.map((line) => `${line}\n`).join(""));
  } catch (error) {
    return failure(error);
  }
}
