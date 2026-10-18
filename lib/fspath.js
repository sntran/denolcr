/**
 * The paths of rclone, as the package fs/fspath of rclone 1.75.1:
 *
 * - `remote:path` is a path of the remote `remote` of the config file.
 * - `:backend:path` is a path of a remote of the type `backend`, with no
 *   config file.
 * - `remote,name=value,flag:path` sets the options `name` and `flag` of the
 *   remote. A value in `'` or `"` quotes can have `,` and `:`, and two
 *   quotes for one quote.
 * - A path with no `:`, or with a `/` before the first `:` or `,`, is a local
 *   path.
 */

/** The regular expression of the name of a remote in the config file. */
export const CONFIG_NAME = String
  .raw`[\w\p{L}\p{N}.+@]+(?:[ -]+[\w\p{L}\p{N}.+@-]+)*`;

const CONFIG_NAME_MATCHER = new RegExp(`^${CONFIG_NAME}$`, "u");
const REMOTE_NAME_MATCHER = new RegExp(`^:?${CONFIG_NAME}(?::$|,)`, "u");

/** The errors, with the text of rclone. */
export const Errors = {
  INVALID_CHARACTERS:
    "config name contains invalid characters - may only contain numbers, letters, `_`, `-`, `.`, `+`, `@` and space, while not start with `-` or space, and not end with space",
  CANT_BE_EMPTY: "can't use empty string as a path",
  BAD_CONFIG_PARAM:
    "config parameters may only contain `0-9`, `A-Z`, `a-z`, `_` and `.`",
  EMPTY_CONFIG_PARAM: "config parameters can't be empty",
  CONFIG_NAME_EMPTY: "config name can't be empty",
  CONFIG_NAME: "config name needs a trailing `:`",
  PARAM: "config parameter must end with `,` or `:`",
  VALUE: "unquoted config value must end with `,` or `:`",
  QUOTED_VALUE: "unterminated quoted config value",
  AFTER_QUOTE: "expecting `:` or `,` or another quote after a quote",
};

/**
 * Tells if a text is a correct name of a remote in the config file.
 * @param {string} name
 */
export function isConfigName(name) {
  return CONFIG_NAME_MATCHER.test(name);
}

/**
 * The parts of a path.
 * @typedef {Object} Parsed
 * @property {string} name The name of the remote, for example `remote`, or
 *   `:backend` for a remote with no config file, or "" for a local path.
 * @property {string} configString The text before the `:`, for example
 *   `:backend,name=value`.
 * @property {string} path The path in the remote, or the local path.
 * @property {Record<string, string>} config The options of the connection
 *   string, with no prototype.
 */

/**
 * Reads a path of rclone, as `Parse` of rclone.
 * @param {string} text For example `remote,name='a:b':path/to/file`.
 * @returns {Parsed}
 * @throws {SyntaxError} When the path is not correct.
 */
export function parse(text) {
  /** @type {Parsed} */
  const parsed = {
    name: "",
    configString: "",
    path: text,
    config: Object.create(null),
  };
  if (text === "") throw new SyntaxError(Errors.CANT_BE_EMPTY);
  // A path with no ":" is a local path.
  if (!text.includes(":")) return parsed;

  const State = {
    CONFIG_NAME: 0,
    PARAM: 1,
    VALUE: 2,
    QUOTED_VALUE: 3,
    AFTER_QUOTE: 4,
    DONE: 5,
  };
  let state = State.CONFIG_NAME;
  let index = 0;
  // The start of the current part.
  let start = 0;
  let quote = "";
  let param = "";
  let doubled = false;

  loop:
  for (; index < text.length; index++) {
    const c = text[index];
    switch (state) {
      case State.CONFIG_NAME:
        if (index === 0 && c === ":") continue;
        if (c === "/" || c === "\\") {
          // A ":" or a "," after a "/" is a part of a local path. A path
          // that starts with ":" is for a remote with no config file.
          if (text[0] === ":") {
            throw new SyntaxError(Errors.INVALID_CHARACTERS);
          }
          return parsed;
        }
        if (c === ":" || c === ",") {
          parsed.name = text.slice(0, index);
          checkRemoteName(`${parsed.name}:`);
          start = index + 1;
          if (c === ":") {
            state = State.DONE;
            break loop;
          }
          state = State.PARAM;
        }
        break;

      case State.PARAM:
        if (c === ":" || c === "," || c === "=") {
          param = text.slice(start, index);
          if (param === "") throw new SyntaxError(Errors.EMPTY_CONFIG_PARAM);
          start = index + 1;
          if (c === "=") {
            state = State.VALUE;
            break;
          }
          parsed.config[param] = "true";
          if (c === ":") {
            state = State.DONE;
            break loop;
          }
        } else if (!/[\w.]/.test(c)) {
          throw new SyntaxError(Errors.BAD_CONFIG_PARAM);
        }
        break;

      case State.VALUE:
        if (c === "'" || c === '"') {
          // A quote starts a value in quotes only at the start of the value.
          if (index === start) {
            quote = c;
            state = State.QUOTED_VALUE;
            start = index + 1;
            doubled = false;
          }
        } else if (c === ":" || c === ",") {
          parsed.config[param] = text.slice(start, index);
          start = index + 1;
          if (c === ":") {
            state = State.DONE;
            break loop;
          }
          state = State.PARAM;
        }
        break;

      case State.QUOTED_VALUE:
        if (c === quote) state = State.AFTER_QUOTE;
        break;

      case State.AFTER_QUOTE:
        if (c === ":" || c === ",") {
          let value = text.slice(start, index - 1);
          if (doubled) value = value.replaceAll(quote + quote, quote);
          parsed.config[param] = value;
          start = index + 1;
          if (c === ":") {
            state = State.DONE;
            break loop;
          }
          state = State.PARAM;
        } else if (c === quote) {
          // Two quotes are one quote in the value.
          state = State.QUOTED_VALUE;
          doubled = true;
        } else {
          throw new SyntaxError(Errors.AFTER_QUOTE);
        }
        break;
    }
  }

  switch (state) {
    case State.CONFIG_NAME:
      throw new SyntaxError(Errors.CONFIG_NAME);
    case State.PARAM:
      throw new SyntaxError(Errors.PARAM);
    case State.VALUE:
      throw new SyntaxError(Errors.VALUE);
    case State.QUOTED_VALUE:
      throw new SyntaxError(Errors.QUOTED_VALUE);
    case State.AFTER_QUOTE:
      throw new SyntaxError(Errors.AFTER_QUOTE);
  }

  parsed.configString = text.slice(0, index);
  parsed.path = text.slice(index + 1);
  return parsed;
}

/**
 * Makes sure that the start of a path is a correct name of a remote, as
 * `checkRemoteName` of rclone.
 * @param {string} name For example `remote:` or `:backend,`.
 * @throws {SyntaxError}
 */
function checkRemoteName(name) {
  if (name === ":" || name === "::") {
    throw new SyntaxError(Errors.CONFIG_NAME_EMPTY);
  }
  if (!REMOTE_NAME_MATCHER.test(name)) {
    throw new SyntaxError(Errors.INVALID_CHARACTERS);
  }
}
