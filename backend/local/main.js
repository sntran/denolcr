import process from "node:process";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { formatBytes } from "../../lib/format.js";
import { escapeHTML } from "../../lib/html.js";
import { mimeType } from "../../lib/mime.js";
import { decodePath } from "../../lib/path.js";

/**
 * Serves a local remote: the files and the folders in the current folder.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function local(request) {
  const { method, url } = request;
  const { pathname, searchParams } = new URL(url);
  const root = process.cwd?.() || ".";
  const path = decodePath(pathname);
  const absolutePath = path === null ? null : join(root, path);

  // A path must not go out of the root, also on Windows, where `\` is a
  // separator too.
  if (absolutePath === null || isOutside(root, absolutePath)) {
    return new Response(null, { status: 400 });
  }

  // Have to use dynamic import here because `fs/promises` is not available in
  // Worker environments.
  const { mkdir, open, readdir, rm, stat } = await import("node:fs/promises");

  /** @type {import("node:fs").Stats | null} */
  const stats = await stat(absolutePath).catch(() => null);

  const headers = new Headers();
  let status = 200, body = null;

  if (method === "HEAD" || method === "GET") {
    if (!stats) {
      return new Response(null, { status: 404 });
    }

    if (stats.isDirectory()) {
      /**
       * @type {import("node:fs").Dirent[]}
       */
      const files = await readdir(absolutePath, { withFileTypes: true });
      files.sort((a, b) => a.name.localeCompare(b.name));

      if (method === "GET") {
        const query = escapeHTML(`${searchParams}`);

        body = new ReadableStream({
          async start(controller) {
            controller.enqueue(`
              <search>
                <form>
                  <label>
                    Filter
                    <input type="search" name="q" />
                  </label>
                </form>
              </search>
            `);
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
                  <td><a href="../?${query}">Go up</a></td>
                  <td>—</td>
                  <td>—</td>
                </tr>
              `);

            for (const file of files) {
              const name = file.name;
              const isDirectory = file.isDirectory();
              const href = `${encodeURIComponent(name)}${
                isDirectory ? "/" : ""
              }`;

              const { size, mtime } = await stat(join(absolutePath, name));

              controller.enqueue(`<tr>
                <td>${isDirectory ? "📁" : "📄"}</td>
                <td>
                  <a
                    href="${href}?${query}"
                    type="${isDirectory ? "" : escapeHTML(mimeType(name))}"
                  >${escapeHTML(name)}</a>
                </td>
                <td>${
                isDirectory ? "—" : `<data
                    value="${size}"
                  >${formatBytes(Number(size), { locale: true })}</data>`
              }
                </td>
                <td>${
                mtime
                  ? `<time
                    datetime="${mtime.toISOString()}"
                  >${mtime.toLocaleString()}</time>`
                  : "-"
              }
                </td>
              </tr>`);
            }

            controller.enqueue("</tbody></table>");
            controller.close();
          },
        }).pipeThrough(new TextEncoderStream());
      }

      headers.set("Content-Type", "text/html;charset=utf-8");
    } else {
      headers.append("Content-Type", mimeType(path));
      headers.append("Content-Length", stats.size.toString());

      if (method === "GET") {
        const file = await open(absolutePath);

        body = new ReadableStream({
          async pull(controller) {
            const chunk = new Uint8Array(64 * 1024);
            const { bytesRead } = await file.read(chunk, 0);
            if (bytesRead === 0) {
              controller.close();
              await file.close();
              return;
            }
            controller.enqueue(chunk.subarray(0, bytesRead));
          },
          async cancel() {
            await file.close();
          },
        });
      }
    }

    const mtime = stats.mtime?.toUTCString();
    if (mtime) headers.append("Last-Modified", mtime);
  } else if (method === "PUT") {
    // Folder ending with trailing slash.
    if (path.endsWith("/")) {
      await mkdir(absolutePath, { recursive: true });
    } else {
      await mkdir(dirname(absolutePath), { recursive: true });
      const file = await open(absolutePath, "w");
      try {
        for await (const chunk of request.body ?? []) {
          await file.write(chunk);
        }
      } finally {
        await file.close();
      }
    }

    status = 201;
    headers.append("Content-Location", pathname);
  } else if (method === "DELETE") {
    if (!stats) {
      return new Response(null, { status: 404 });
    }
    // The root is the current folder, which must stay.
    if (path === "/") {
      return new Response(null, { status: 403 });
    }

    await rm(absolutePath, { recursive: true });
    status = 204;
  } else {
    status = 405;
    headers.set("Allow", "GET, HEAD, PUT, DELETE");
  }

  return new Response(body, {
    status,
    headers,
  });
}

/**
 * Tells if a path is out of the root folder.
 * @param {string} root
 * @param {string} path
 * @returns {boolean}
 */
function isOutside(root, path) {
  const rest = relative(root, path);
  return rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest);
}

export default {
  fetch: local,
};
