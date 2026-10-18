/**
 * The list of a folder in HTML, as CONTRIBUTING.md tells: the rows of a
 * `<table>`. In each row, `<a href>` is the link to the file or the folder,
 * with a `/` at the end for a folder, `type` is the media type, `<data
 * value>` is the size in bytes, and `<time datetime>` is the time of the last
 * change.
 */
import { formatBytes } from "./format.js";
import { escapeHTML, scanTags } from "./html.js";
import { toLocaleISOString } from "./time.js";

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
 *
 * The read is `scanTags` of `html.js`, not HTMLRewriter: in Node.js and in
 * Deno, HTMLRewriter is WebAssembly, and its load and each element in it
 * cost much time. The rules are the rules of the selectors `tr a[href]`,
 * `tr data[value]` and `tr time[datetime]` of HTMLRewriter.
 * @param {Response} response
 * @param {URL} base The URL of the folder.
 * @returns {Promise<Entry[]>}
 */
export async function readListing(response, base) {
  /** @type {Entry[]} */
  const entries = [];
  /**
   * The entry of the current row, at the end of `entries`.
   * @type {Entry | null}
   */
  let entry = null;
  /** The number of open `tr` elements. */
  let rows = 0;

  scanTags(await response.text(), {
    start(name, attributes) {
      if (name === "tr") {
        rows++;
        entry = null;
        return;
      }
      if (rows === 0) return;
      if (name === "a") {
        const href = attributes.get("href");
        if (href === undefined) return;
        const child = childOf(href, base);
        if (child === null) return;
        const isDir = child.endsWith("/");
        const link = {
          Name: isDir ? child.slice(0, -1) : child,
          IsDir: isDir,
          Size: -1,
          MimeType: attributes.get("type") || "",
          ModTime: "",
        };
        // The last link of a row gives the entry of the row.
        if (entry) entries[entries.length - 1] = link;
        else entries.push(link);
        entry = link;
      } else if (name === "data") {
        const value = attributes.get("value");
        if (entry && value !== undefined) entry.Size = Number(value);
      } else if (name === "time") {
        const datetime = attributes.get("datetime");
        if (entry && datetime !== undefined) entry.ModTime = datetime;
      }
    },
    end(name) {
      if (name === "tr") rows--;
    },
  });

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
      // The digits after the second of the time stay, as the precision of
      // the remote.
      const datetime = toLocaleISOString(ModTime, 0);
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
        time && datetime
          ? `<time datetime="${datetime}">${time.toLocaleString()}</time>`
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
 * Writes the list of another backend again, with a query in each link, for
 * a backend on top of another backend. The links of the other backend have
 * its own options, which are not the options of a request to this backend.
 * @param {Response} response The list of the other backend.
 * @param {string} query The query, with no secret option.
 * @returns {Promise<Response>}
 */
export async function relink(response, query) {
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.set("Content-Type", "text/html;charset=utf-8");
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers,
  };
  // The answer to HEAD has no body.
  if (response.body === null) return new Response(null, init);
  const entries = await readListing(response, new URL("http://remote/folder/"));
  return new Response(renderListing(entries, { query }), init);
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
