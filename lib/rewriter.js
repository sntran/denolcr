/**
 * HTMLRewriter, to read the elements of an HTML document, for example the
 * list of a folder:
 *
 * ```js
 * await readElements(response, [
 *   ["tr a[href]", { element(element) { attributeOf(element, "href"); } }],
 * ]);
 * ```
 *
 * HTMLRewriter is lol-html, the HTML parser of Cloudflare, as the HTML
 * standard tells: thus a list from a server reads the same in each runtime.
 * In workerd and in Bun, HTMLRewriter is a part of the runtime. In Node.js and
 * in Deno, it is the lol-html of `@sntran/lol-html` in WebAssembly, which
 * loads at its first use: a command that reads no list does not need it.
 */
import { decodeHTMLAttribute } from "entities/decode";

/**
 * The handlers of the elements of a selector. A handler only reads: it is
 * not async, and it does not change the document.
 * @typedef {Object} ElementHandlers
 * @property {(element: Element) => void} [element]
 */

/**
 * An element of the document, in the handler of its start tag.
 * @typedef {Object} Element
 * @property {string} tagName
 * @property {(name: string) => string | null | undefined} getAttribute
 * @property {(handler: () => void) => void} onEndTag
 */

/**
 * The lol-html of WebAssembly, at its first use.
 * @type {Promise<{ HTMLRewriter: any }> | undefined}
 */
let loaded;

/**
 * Reads an HTML document, and calls the handlers of each selector for its
 * elements. The document is UTF-8, as for rclone.
 * @param {Response} response
 * @param {Array<[string, ElementHandlers]>} handlers
 * @returns {Promise<void>}
 */
export async function readElements(response, handlers) {
  if (!response.body) return;
  // @ts-ignore: HTMLRewriter is a global of workerd and of Bun.
  const Native = globalThis.HTMLRewriter;
  if (typeof Native === "function") {
    const rewriter = new Native();
    for (const [selector, handler] of handlers) rewriter.on(selector, handler);
    // Only the handlers read the document: its output goes away. The
    // runtime reads the output with no JavaScript between the chunks.
    await rewriter.transform(response).arrayBuffer();
    return;
  }

  loaded ??= import("@sntran/lol-html");
  const { HTMLRewriter } = await loaded;
  // The output of each chunk goes away. With no stream between the chunks,
  // no queue of output chunks grows.
  const rewriter = new HTMLRewriter("utf-8", () => {});
  try {
    for (const [selector, handler] of handlers) rewriter.on(selector, handler);
    for await (const chunk of response.body) rewriter.write(chunk);
    rewriter.end();
  } finally {
    rewriter.free();
  }
}

/**
 * The value of an attribute of an element, or null when the element does not
 * have the attribute. HTMLRewriter gives the value as it is in the document:
 * this function decodes its character references, as the HTML standard tells,
 * for example `a&amp;b` gives `a&b`.
 * @param {Element} element
 * @param {string} name
 * @returns {string | null}
 */
export function attributeOf(element, name) {
  const value = element.getAttribute(name);
  return value == null ? null : decodeHTMLAttribute(value);
}
