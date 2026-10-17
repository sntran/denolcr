import { HTMLRewriter } from "@sntran/html-rewriter";

/**
 * An entry of the list of a folder, with the names of `rclone lsjson`.
 * @typedef {Object} Entry
 * @property {string} Name The name, with no percent-encoding.
 * @property {boolean} IsDir
 * @property {number} Size The value of `<data>`, or -1 when there is none.
 * @property {string} MimeType The `type` of the link, or "".
 * @property {string} ModTime The `datetime` of `<time>`, or "".
 */

/**
 * Reads the list of a folder from its HTML: the rows of a `<table>`, as
 * CONTRIBUTING.md tells. In each row, `<a href>` is the link to the file or
 * the folder, with a `/` at the end for a folder, `type` is the media type,
 * `<data value>` is the size in bytes, and `<time datetime>` is the time of
 * the last change.
 *
 * Only a link to a file or a folder directly in the folder makes an entry.
 * Thus the row of the parent folder (`../`) is not an entry, and a name that
 * has no percent-encoding for `?`, `#` or `/` gives a wrong entry.
 * @param {Response} response
 * @param {URL} base The URL of the folder.
 * @returns {Promise<Entry[]>}
 */
export async function parseListing(response, base) {
  /** @type {Entry[]} */
  const entries = [];
  /** @type {Entry | null} */
  let entry = null;

  await new HTMLRewriter()
    .on("tr", {
      element(element) {
        entry = null;
        element.onEndTag(() => {
          if (entry) entries.push(entry);
        });
      },
    })
    .on("tr a[href]", {
      element(element) {
        const { origin, pathname } = new URL(
          element.getAttribute("href"),
          base,
        );
        if (origin !== base.origin || !pathname.startsWith(base.pathname)) {
          return;
        }
        const rest = pathname.slice(base.pathname.length);
        const isDir = rest.endsWith("/");
        const name = isDir ? rest.slice(0, -1) : rest;
        if (name === "" || name.includes("/")) return;

        entry = {
          Name: decodeURIComponent(name),
          IsDir: isDir,
          Size: -1,
          MimeType: element.getAttribute("type") || "",
          ModTime: "",
        };
      },
    })
    .on("tr data[value]", {
      element(element) {
        if (entry) entry.Size = Number(element.getAttribute("value"));
      },
    })
    .on("tr time[datetime]", {
      element(element) {
        if (entry) entry.ModTime = element.getAttribute("datetime");
      },
    })
    .transform(response)
    .arrayBuffer();

  return entries;
}
