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
