/**
 * A small reader of XML, for the answers of APIs such as S3: elements, text,
 * CDATA and the entities. It does not read a DTD, and it does not keep the
 * attributes. A name has no namespace prefix: `s3:Key` is `Key`.
 */

/**
 * An element of an XML document.
 * @typedef {Object} XMLElement
 * @property {string} name The name with no namespace prefix.
 * @property {XMLElement[]} children The elements in the element.
 * @property {string} text The text in the element, with no text of the
 *   elements in it.
 */

const TOKENS =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)[^>]*?(\/?)>|([^<]+)/g;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Reads an XML document.
 * @param {string} text
 * @returns {XMLElement} The root element.
 * @throws {SyntaxError} When the elements do not close in order.
 */
export function parseXML(text) {
  /** @type {XMLElement} */
  const document = { name: "", children: [], text: "" };
  const stack = [document];
  for (const match of text.matchAll(TOKENS)) {
    const [, cdata, close, name, empty, chars] = match;
    const top = stack.at(-1);
    if (cdata !== undefined) {
      top.text += cdata;
    } else if (chars !== undefined) {
      top.text += decodeEntities(chars);
    } else if (name !== undefined) {
      const local = name.slice(name.indexOf(":") + 1);
      if (close) {
        if (stack.length === 1 || top.name !== local) {
          throw new SyntaxError(`unexpected </${name}>`);
        }
        stack.pop();
      } else {
        const element = { name: local, children: [], text: "" };
        top.children.push(element);
        if (!empty) stack.push(element);
      }
    }
  }
  if (stack.length !== 1 || document.children.length !== 1) {
    throw new SyntaxError("not one root element");
  }
  return document.children[0];
}

/**
 * The elements with a name in an element.
 * @param {XMLElement | undefined} element
 * @param {string} name
 * @returns {XMLElement[]}
 */
export function childrenOf(element, name) {
  return element?.children.filter((child) => child.name === name) ?? [];
}

/**
 * The text of the first element with a name in an element, or "".
 * @param {XMLElement | undefined} element
 * @param {string} name
 * @returns {string}
 */
export function textOf(element, name) {
  return childrenOf(element, name)[0]?.text ?? "";
}

/**
 * Tells if XML 1.0 can have a text: it cannot have the control characters
 * other than tab and line breaks, also as a character reference.
 * @param {string} text
 * @returns {boolean}
 */
export function isXMLText(text) {
  return !/[\0-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    .test(text);
}

/**
 * Puts the escapes of XML in a text, for an element. A carriage return is
 * `&#13;`, else XML reads it as a line feed.
 * @param {string} text
 * @returns {string}
 */
export function escapeXML(text) {
  return text.replace(
    /[&<>"'\r]/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
        "\r": "&#13;",
      })[c],
  );
}

/** @param {string} text */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[body] ?? entity;
  });
}
