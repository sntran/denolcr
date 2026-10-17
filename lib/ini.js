/**
 * The INI format of the configuration file of rclone:
 *
 * ```ini
 * [remote]
 * type = s3
 * provider = Cloudflare
 *
 * [secret]
 * type = crypt
 * remote = remote:bucket
 * ```
 *
 * A `[name]` line starts a section, and each `key = value` line is a string
 * in the current section. A line that starts with `#` or `;` is a comment.
 */

/**
 * Reads the text of a configuration file. The keys before the first section
 * are at the top level. Two sections with the same name become one, as in
 * rclone.
 * @param {string} text
 * @returns {Record<string, string | Record<string, string>>}
 */
export function parse(text) {
  /** @type {Map<string, string | Map<string, string>>} */
  const config = new Map();
  let section = config;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const content = line.trim();
    if (content === "" || content.startsWith("#") || content.startsWith(";")) {
      continue;
    }
    const name = /^\[(.*)\]$/.exec(content)?.[1];
    if (name !== undefined) {
      if (!(config.get(name) instanceof Map)) {
        config.set(name, new Map());
      }
      section = config.get(name);
      continue;
    }
    const equal = content.indexOf("=");
    if (equal === -1) {
      throw new SyntaxError(`INI: line ${index + 1} has no "=": ${content}`);
    }
    section.set(
      content.slice(0, equal).trim(),
      content.slice(equal + 1).trim(),
    );
  }
  // Object.fromEntries makes own properties, so a name such as "__proto__"
  // does not change the prototype.
  return Object.fromEntries(
    [...config].map((
      [key, value],
    ) => [key, value instanceof Map ? Object.fromEntries(value) : value]),
  );
}

/**
 * Writes a configuration file: first the keys at the top level, then each
 * section, with an empty line between the sections, as rclone writes them.
 * A key with no value (undefined or null) is not written.
 * @param {Record<string, unknown>} config
 * @param {{ section?: string }} [options] With a `section`, `config` is the
 *   keys of that one section.
 * @returns {string}
 */
export function stringify(config, { section } = {}) {
  if (section) {
    return stringify({ [section]: config });
  }
  const isSection = (value) => typeof value === "object" && value !== null;
  const lines = (entries) =>
    entries
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key} = ${value}`);

  const entries = Object.entries(config);
  const blocks = [lines(entries.filter(([, value]) => !isSection(value)))];
  for (const [name, keys] of entries.filter(([, value]) => isSection(value))) {
    blocks.push([`[${name}]`, ...lines(Object.entries(keys))]);
  }
  return blocks.filter((block) => block.length).map((block) => block.join("\n"))
    .join("\n\n");
}
