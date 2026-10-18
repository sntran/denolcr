/** The characters that have a meaning in HTML, and their references. */
const REFERENCES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Puts a character reference in place of each character of the text that has
 * a meaning in HTML. The result is safe as the text of an element, and as the
 * value of an attribute in quotes.
 * @param {string} text
 * @returns {string}
 */
export function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, (character) => REFERENCES[character]);
}

/** The elements with no end tag, as the HTML standard tells. */
const VOID = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * The elements with text that is not markup: only their end tag ends them.
 * The text of `plaintext` goes to the end of the document.
 */
const RAW = new Set([
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

/** The basic character references, with no `;` at the end. */
const BASIC = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Puts the characters in place of the basic character references of an
 * attribute value: `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, and the
 * numeric references, for example `&#39;` and `&#x27;`. Other named
 * references stay as they are. As the HTML standard tells, a reference with
 * no `;` and a letter, a digit or `=` after it is text.
 * @param {string} value
 * @returns {string}
 */
export function decodeAttribute(value) {
  if (!value.includes("&")) return value;
  return value.replace(
    /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot)|(apos);)(;?)(?=([=A-Za-z0-9]?))/g,
    (reference, decimal, hex, name, apos, semicolon, after) => {
      if (name !== undefined) {
        if (!semicolon && after) return reference;
        return BASIC[name];
      }
      if (apos !== undefined) return `'${semicolon}`;
      const code = decimal !== undefined
        ? Number.parseInt(decimal, 10)
        : Number.parseInt(hex, 16);
      const valid = code > 0 && code <= 0x10ffff &&
        (code < 0xd800 || code > 0xdfff);
      return String.fromCodePoint(valid ? code : 0xfffd);
    },
  );
}

/**
 * The start and the end of each element of an HTML document. The scan
 * follows the tokenizer of the HTML standard for tags, attributes, comments
 * and the text of elements such as `script`, but it does not make a tree:
 * an end tag ends the last open element with its name, and an end tag with
 * no such element does nothing.
 * @typedef {Object} TagHandlers
 * @property {(name: string, attributes: Map<string, string>) => void} start
 *   The name in lower case, and the attributes: the name of each in lower
 *   case, and its value after `decodeAttribute`. As in the standard, the
 *   first attribute with a name wins.
 * @property {(name: string) => void} [end] The element ends: its end tag, or
 *   the end tag of an element that has it in it.
 */

/**
 * Scans the tags of an HTML document.
 * @param {string} html
 * @param {TagHandlers} handlers
 */
export function scanTags(html, { start, end }) {
  /** The names of the open elements, from the first. */
  const open = [];
  const length = html.length;
  let position = 0;
  for (;;) {
    const lt = html.indexOf("<", position);
    if (lt === -1 || lt + 1 >= length) return;
    const next = html.charCodeAt(lt + 1);

    if (next === 0x21) { // `<!`: a comment, a doctype or a bogus comment.
      if (html.startsWith("<!--", lt)) {
        if (html.startsWith("<!-->", lt)) position = lt + 5;
        else if (html.startsWith("<!--->", lt)) position = lt + 6;
        else {
          const close = html.indexOf("-->", lt + 4);
          if (close === -1) return;
          position = close + 3;
        }
      } else {
        const close = html.indexOf(">", lt + 2);
        if (close === -1) return;
        position = close + 1;
      }
      continue;
    }
    if (next === 0x3f) { // `<?`: a bogus comment.
      const close = html.indexOf(">", lt + 2);
      if (close === -1) return;
      position = close + 1;
      continue;
    }

    const isEnd = next === 0x2f; // `</`
    const first = isEnd ? lt + 2 : lt + 1;
    if (!isLetter(html.charCodeAt(first))) {
      if (!isEnd) { // Text, for example `a < b`.
        position = lt + 1;
        continue;
      }
      // `</>` is nothing, and `</` with no letter is a bogus comment.
      const close = html.indexOf(">", first);
      if (close === -1) return;
      position = close + 1;
      continue;
    }

    let index = first;
    while (index < length && !isNameEnd(html.charCodeAt(index))) index++;
    const name = html.slice(first, index).toLowerCase();
    const attributes = new Map();
    index = readAttributes(html, index, attributes);
    // A tag that the document does not end is not a tag.
    if (index === -1) return;
    position = index;

    if (isEnd) {
      const at = open.lastIndexOf(name);
      if (at !== -1) {
        while (open.length > at) {
          const element = open.pop();
          end?.(element);
        }
      }
      continue;
    }

    start(name, attributes);
    if (VOID.has(name)) continue;
    open.push(name);
    if (RAW.has(name)) {
      if (name === "plaintext") return;
      const close = findEndTag(html, name, position);
      if (close === -1) return;
      position = close;
    }
  }
}

/** @param {number} code */
function isLetter(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** Tab, line feed, form feed, carriage return and space. */
function isSpace(code) {
  return code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0c ||
    code === 0x0d;
}

/** The end of a tag name: a space, `/` or `>`. */
function isNameEnd(code) {
  return isSpace(code) || code === 0x2f || code === 0x3e;
}

/**
 * Reads the attributes of a tag, after its name.
 * @param {string} html
 * @param {number} index After the name of the tag.
 * @param {Map<string, string>} attributes
 * @returns {number} After the `>` of the tag, or -1 when the document ends
 *   in the tag.
 */
function readAttributes(html, index, attributes) {
  const length = html.length;
  for (;;) {
    while (index < length) {
      const code = html.charCodeAt(index);
      if (!isSpace(code) && code !== 0x2f) break;
      index++;
    }
    if (index >= length) return -1;
    if (html.charCodeAt(index) === 0x3e) return index + 1;

    // The name. Its first character can be `=`.
    const start = index++;
    while (index < length) {
      const code = html.charCodeAt(index);
      if (isNameEnd(code) || code === 0x3d) break;
      index++;
    }
    const name = html.slice(start, index).toLowerCase();
    while (index < length && isSpace(html.charCodeAt(index))) index++;

    let value = "";
    if (index < length && html.charCodeAt(index) === 0x3d) {
      index++;
      while (index < length && isSpace(html.charCodeAt(index))) index++;
      if (index >= length) return -1;
      const quote = html.charCodeAt(index);
      if (quote === 0x22 || quote === 0x27) {
        const close = html.indexOf(quote === 0x22 ? '"' : "'", index + 1);
        if (close === -1) return -1;
        value = html.slice(index + 1, close);
        index = close + 1;
      } else {
        const begin = index;
        while (index < length) {
          const code = html.charCodeAt(index);
          if (isSpace(code) || code === 0x3e) break;
          index++;
        }
        value = html.slice(begin, index);
      }
    }
    if (!attributes.has(name)) attributes.set(name, decodeAttribute(value));
  }
}

/**
 * Finds the end tag of an element whose text is not markup, for example
 * `</script>`, with no regard to case.
 * @param {string} html
 * @param {string} name In lower case.
 * @param {number} from
 * @returns {number} The index of the `<` of the end tag, or -1.
 */
function findEndTag(html, name, from) {
  for (let index = from;; index++) {
    index = html.indexOf("</", index);
    if (index === -1) return -1;
    const after = index + 2 + name.length;
    if (
      html.slice(index + 2, after).toLowerCase() === name &&
      (after >= html.length || isNameEnd(html.charCodeAt(after)))
    ) {
      return index;
    }
  }
}
