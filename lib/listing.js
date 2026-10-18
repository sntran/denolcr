/**
 * The list of a folder in HTML, as CONTRIBUTING.md tells: the rows of a
 * `<table>`. In each row, `<a href>` is the link to the file or the folder,
 * with a `/` at the end for a folder, `type` is the media type, `<data
 * value>` is the size in bytes, and `<time datetime>` is the time of the last
 * change.
 */
import { HTMLRewriter } from "@sntran/html-rewriter";
import { formatBytes } from "./format.js";
import { escapeHTML } from "./html.js";

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
 * Reads the entries of the list of a folder. Only a link to a file or a
 * folder directly in the folder makes an entry. Thus the row of the parent
 * folder (`../`) is not an entry, and a name that has no percent-encoding
 * for `?`, `#` or `/` gives a wrong entry.
 * @param {Response} response
 * @param {URL} base The URL of the folder.
 * @returns {Promise<Entry[]>}
 */
export async function readListing(response, base) {
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
        const name = childOf(element.getAttribute("href"), base);
        if (name === null) return;
        const isDir = name.endsWith("/");
        entry = {
          Name: isDir ? name.slice(0, -1) : name,
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

/**
 * The order of the names of a list. It gives the same order as
 * `localeCompare`, which makes a new collator for each call.
 * @type {Intl.Collator | undefined}
 */
let collator;

/**
 * Writes the list of a folder.
 * @param {Entry[]} entries
 * @param {{ query?: string }} [options] `query` goes in each link, for
 *   example the options of the backend, with no secret.
 * @returns {ReadableStream<Uint8Array>}
 */
export function renderListing(entries, { query = "" } = {}) {
  const suffix = escapeHTML(query ? `?${query}` : "");
  collator ??= new Intl.Collator();
  const { compare } = collator;
  const rows = entries.toSorted((a, b) => compare(a.Name, b.Name)).map(
    ({ Name, IsDir, Size, MimeType, ModTime }) => {
      const href = `${encodeURIComponent(Name)}${IsDir ? "/" : ""}`;
      const time = ModTime ? new Date(ModTime) : null;
      return `
          <tr>
            <td>${IsDir ? "📁" : "📄"}</td>
            <td><a href="${href}${suffix}" type="${
        escapeHTML(IsDir ? "" : MimeType)
      }">${escapeHTML(IsDir ? `${Name}/` : Name)}</a></td>
            <td>${
        IsDir || Size < 0
          ? "—"
          : `<data value="${Size}">${
            formatBytes(Size, { locale: true })
          }</data>`
      }</td>
            <td>${
        time && !isNaN(time)
          ? `<time datetime="${time.toISOString()}">${time.toLocaleString()}</time>`
          : "-"
      }</td>
          </tr>`;
    },
  );

  const html = `
      <table cellpadding="4">
        <thead>
          <tr>
            <th></th>
            <th>Name</th>
            <th>Size</th>
            <th>Modified</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>📁</td>
            <td><a href="../${suffix}">Go up</a></td>
            <td>—</td>
            <td>—</td>
          </tr>${rows.join("")}
        </tbody>
      </table>
    `;
  return new Blob([html]).stream();
}

/**
 * Puts a query in place of the query of each link of a list, for a backend
 * on top of another backend. The links of the other backend have its own
 * options, which are not the options of a request to this backend.
 * @param {Response} response The list of the other backend.
 * @param {string} query The query, with no secret option.
 * @returns {Response}
 */
export function relink(response, query) {
  const suffix = query ? `?${query}` : "";
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  const rewritten = new HTMLRewriter()
    .on("tr a[href]", {
      element(element) {
        const href = element.getAttribute("href");
        // Only a relative link, which stays in the backend.
        if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return;
        element.setAttribute("href", href.replace(/[?#].*$/s, "") + suffix);
      },
    })
    .transform(response);
  return new Response(rewritten.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The name of a file (`name`) or a folder (`name/`) directly in a folder,
 * from a link, or null when the link is not to such a child. The query and
 * the fragment of the link are not a part of the name.
 * @param {string} href
 * @param {URL} base The URL of the folder.
 * @returns {string | null}
 */
export function childOf(href, base) {
  const { origin, pathname } = new URL(href, base);
  if (origin !== base.origin || !pathname.startsWith(base.pathname)) {
    return null;
  }
  const rest = pathname.slice(base.pathname.length);
  const isDir = rest.endsWith("/");
  const name = isDir ? rest.slice(0, -1) : rest;
  if (name === "" || name.includes("/")) return null;
  try {
    return decodeURIComponent(name) + (isDir ? "/" : "");
  } catch {
    return null;
  }
}
