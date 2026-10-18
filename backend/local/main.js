import process from "node:process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { formatBytes } from "@rfetch/lib/format";
import { escapeHTML } from "@rfetch/lib/html";
import { mimeType } from "@rfetch/lib/mime";
import { decodePath } from "@rfetch/lib/path";
import { notSatisfiable, parseRange, partialHeaders } from "@rfetch/lib/range";

/**
 * Serves a local remote: the files and the folders in its root. The root is
 * the current folder, or `RFETCH_LOCAL_ROOT` of `env`.
 *
 * The fetch of rfetch sets the root `/` only for a local path of the command
 * line or of the code, for example `/tmp/file.txt`: an option, a header or
 * the query cannot set it. Thus a request from a client of `rfetch serve`,
 * which has no `env`, stays in the current folder.
 * @param {Request} request
 * @param {Record<string, unknown>} [env]
 * @returns {Promise<Response>}
 */
async function local(request, env = {}) {
  const { method, url } = request;
  const { pathname, searchParams } = new URL(url);
  const cwd = process.cwd?.() || ".";
  const root = typeof env.RFETCH_LOCAL_ROOT === "string"
    ? env.RFETCH_LOCAL_ROOT
    : cwd;
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
      // The stat of each file, at the same time: one after the other takes
      // much more time. A file that goes away before its stat is not in
      // the list.
      const fileStats = await Promise.all(
        files.map((file) =>
          stat(join(absolutePath, file.name)).catch(() => null)
        ),
      );

      if (method === "GET") {
        const query = escapeHTML(`${searchParams}`);

        body = new ReadableStream({
          start(controller) {
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

            for (const [index, file] of files.entries()) {
              if (!fileStats[index]) continue;
              const name = file.name;
              const isDirectory = file.isDirectory();
              const href = `${encodeURIComponent(name)}${
                isDirectory ? "/" : ""
              }`;

              const { size, mtimeMs } = fileStats[index];
              const mtime = timeOf(mtimeMs);

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
      headers.set("Accept-Ranges", "bytes");

      if (method === "GET") {
        let range;
        try {
          range = parseRange(request.headers.get("Range"), stats.size);
        } catch {
          return notSatisfiable(stats.size);
        }
        if (range) {
          status = 206;
          for (
            const [name, value] of Object.entries(
              partialHeaders(range, stats.size),
            )
          ) {
            headers.set(name, value);
          }
        }
        // The position of the next byte, and the number of bytes to read.
        let position = range?.start ?? 0;
        let remaining = range ? range.end - range.start + 1 : stats.size;
        const file = await open(absolutePath);

        body = new ReadableStream({
          async pull(controller) {
            // A read of 1 MiB: each read is a call to the system, and parts
            // of 64 KiB make a read of a large file much slower.
            const chunk = new Uint8Array(Math.min(1024 * 1024, remaining));
            const { bytesRead } = remaining > 0
              ? await file.read(chunk, 0, chunk.length, position)
              : { bytesRead: 0 };
            if (bytesRead === 0) {
              controller.close();
              await file.close();
              return;
            }
            position += bytesRead;
            remaining -= bytesRead;
            controller.enqueue(chunk.subarray(0, bytesRead));
          },
          async cancel() {
            await file.close();
          },
        });
      }
    }

    if (stats.mtimeMs !== undefined) {
      headers.append("Last-Modified", timeOf(stats.mtimeMs).toUTCString());
    }
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
    // The root and the current folder must stay.
    if (path === "/" || resolve(absolutePath) === resolve(cwd)) {
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

/**
 * The time of a file to the millisecond. As in Go, the time is cut, not
 * rounded: the `mtime` of Node.js is rounded to the nearest millisecond.
 * @param {number} mtimeMs
 * @returns {Date}
 */
function timeOf(mtimeMs) {
  return new Date(Math.floor(mtimeMs));
}

export default {
  fetch: local,
};
