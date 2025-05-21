#!/usr/bin/env -S deno serve --allow-all

/**
 * The HTTP remote is a read only remote for reading files of a webserver. The
 * webserver should provide file listings which rfetch will read and turn into
 * a remote.
 *
 * Paths are specified as `remote:` or `remote:path`.
 *
 * The `remote:` represents the configured url, and any path following it will
 * be resolved relative to this url, according to the URL standard. This means
 * with remote url `https://beta.rfetch.com/branch` and path `fix`, the
 * resolved URL will be `https://beta.rfetch.com/branch/fix`, while with path
 * `/fix` the resolved URL will be `https://beta.rfetch.com/fix` as the
 * absolute path is resolved from the root of the domain.
 *
 * If the path following the `remote:` ends with `/` it will be assumed to
 * point to a directory. If the path does not end with `/`, then a HEAD request
 * is sent and the response used to decide if it it is treated as a file or a
 * directory (run with `-vv` to see details). When --http-no-head is specified,
 * a path without ending `/` is always assumed to be a file. If rfetch
 * incorrectly assumes the path is a file, the solution is to specify the path
 * with ending `/`. When you know the path is a directory, ending it with `/`
 * is always better as it avoids the initial HEAD request.
 *
 * To just download a single file it is easier to use [copyurl](../../cmd/copyurl/main.js).
 */

import { formatBytes, HTMLRewriter, toLocaleISOString } from "../../deps.js";

export const options = {
  boolean: [
    "no-head",
    "no-slash",
  ],
  string: [
    "url",
    "method",
  ],
  default: {
    "no-head": false,
    "no-slash": false,
  },
};

/**
 * Serves a HTTP remote.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function http(request) {
  const { url, body } = request;
  const { pathname, searchParams } = new URL(url);

  const remote = searchParams.get("url");
  if (!remote) {
    return new Response("Missing URL", { status: 400 });
  }
  const method = searchParams.get("method") || request.method;

  const headers = (searchParams.get("headers") || "").split(",").reduce(
    (headers, header) => {
      if (!header) return headers;
      const [key, value] = header.split(",", 2);
      headers.set(key, value);
      return headers;
    },
    new Headers(),
  );

  /**
   * @type {RequestInit}
   */
  const init = {
    method: searchParams.get("method") || method,
    headers,
    body,
  };

  const response = await fetch(`${remote}${pathname}`, init);

  if (!pathname.endsWith("/")) {
    return response;
  }

  const listing = new ReadableStream({
    start(controller) {
      controller.enqueue(`
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
            <td><a href="../?${searchParams}">Go up</a></td>
            <td>—</td>
            <td>—</td>
          </tr>
      `);

      /**
       * @type {import("../../mod.js").File}
       */
      let item;

      const rewriter = new HTMLRewriter();
      rewriter.on(`tbody tr`, {
        element(element) {
          // Start a new item.
          item = {
            Path: "",
            Name: "",
            Size: 0,
            MimeType: "",
            ModTime: "",
            IsDir: true,
          };

          element.onEndTag(() => {
            if (!item) return;

            let lastModified;
            if (item.ModTime) {
              lastModified = new Date(item.ModTime);
            }
            controller.enqueue(`<tr>
              <td>${item.IsDir ? "📁" : "📄"}</td>
              <td>
                <a
                  href="${item.Path}?${searchParams}"
                >${item.Name}</a>
              <td>
                ${
              item.Size
                ? `<data
                      value="${item.Size}"
                    >${formatBytes(item.Size, { locale: true })}</data>`
                : "—"
            }
              </td>
              <td>
                ${
              lastModified
                ? `<time
                      datetime="${lastModified.toISOString()}"
                    >${lastModified.toLocaleString()}</time>`
                : "-"
            }
              </td>
            </tr>`);
          });
        },
      });

      rewriter.on(`tbody tr a[href]`, {
        element(element) {
          const href = element.getAttribute("href");
          if (href === "..") {
            item = null;
            return;
          }

          item.Path = href;
          item.IsDir = href.endsWith("/");
        },
        text(chunk) {
          if (!item) return;
          item.Name += chunk.text;
          if (chunk.lastInTextNode) {
            item.Name = item.Name.trim();
          }
        },
      });

      rewriter.on(`tbody tr data[value], tr td[data-size]`, {
        element(element) {
          let size = element.getAttribute("value");
          if (!size) {
            size = element.getAttribute("data-size");
          }
          item.Size = Number(size);
        },
      });

      rewriter.on(`tbody tr time[datetime]`, {
        element(element) {
          const value = element.getAttribute("datetime");
          if (value) {
            item.ModTime = toLocaleISOString(value);
          }
        },
      });

      rewriter.on(`tbody`, {
        element(element) {
          element.onEndTag(() => {
            controller.enqueue("</tbody></table>");
            controller.close();
          });
        },
      });

      rewriter.transform(response).body.pipeTo(new WritableStream());
    },
  }).pipeThrough(new TextEncoderStream());

  return new Response(listing, {
    headers: {
      "Content-Type": "text/html;charset=utf-8",
    },
  });
}

export default {
  fetch: http,
};
