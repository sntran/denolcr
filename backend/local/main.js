#!/usr/bin/env -S deno serve --allow-all

import process from "node:process";
import { contentType, extname, formatBytes, join } from "../../deps.js";

/**
 * Serves a local remote
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function local(request) {
  const { method, url } = request;
  const { pathname, searchParams } = new URL(url);
  const absolutePath = join(process.cwd?.() || ".", pathname);

  // Have to use dynamic import here because `fs/promises` is not available in
  // Worker environments.
  const { mkdir, open, readdir, rm, stat } = await import("node:fs/promises");

  let stats;

  const headers = new Headers();
  let status = 200, body = null;

  if (method === "HEAD" || method === "GET") {
    stats = await stat(absolutePath);

    if (stats.isDirectory()) {
      /**
       * @type {import("node:fs").Dirent[]}
       */
      const files = await readdir(absolutePath, { withFileTypes: true });
      files.sort((a, b) => a.name.localeCompare(b.name));

      if (method === "GET") {
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
                  <td><a href="../?${searchParams}">Go up</a></td>
                  <td>—</td>
                  <td>—</td>
                </tr>
              `);

            for await (const file of files) {
              const name = file.name;
              let filePath = file.name;
              const isDirectory = file.isDirectory();
              if (isDirectory) {
                filePath += "/";
              }

              const { size, mtime } = await stat(
                join(absolutePath, filePath),
              );

              controller.enqueue(`<tr>
                <td>${isDirectory ? "📁" : "📄"}</td>
                <td>
                  <a
                    href="${filePath}?${searchParams}"
                    type=""
                  >${name}</a>
                </td>
                <td>
                  <data
                    value="${size}"
                  >${
                size ? formatBytes(Number(size), { locale: true }) : "—"
              }</data>
                </td>
                <td>${
                mtime
                  ? `<time
                    datetime="${mtime.toISOString()}"
                  >${mtime.toLocaleString()}</time>`
                  : "-"
              }
                </td>

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
      headers.append("Content-Type", contentType(extname(pathname)) || "");
      headers.append("Content-Length", stats.size.toString());

      if (method === "GET") {
        const file = await open(absolutePath);

        body = new ReadableStream({
          async pull(controller) {
            const chunk = new Uint8Array(64 * 1024);
            const { bytesRead } = await file.read(chunk, 0);
            controller.enqueue(chunk.slice(0, bytesRead));
            if (bytesRead === 0) {
              controller.close();
              file.close();
            }
          },
          cancel() {
            file.close();
          },
        });
      }
    }

    const mtime = stats.mtime?.toUTCString();
    if (mtime) headers.append("Last-Modified", mtime);
  }

  /** `PUT` upserts a file at `pathname`. */
  if (method === "PUT") {
    // Folder ending with trailing slash.
    if (pathname.endsWith("/")) {
      await mkdir(absolutePath, { recursive: true });
    } else {
      const file = await open(absolutePath, "w");
      await request.body.pipeTo(
        new WritableStream({
          async write(chunk) {
            await file.write(chunk);
          },
          async close() {
            await file.close();
          },
        }),
      );
    }

    status = 201;
    headers.append("Content-Location", pathname);
  }

  if (method === "DELETE") {
    await rm(absolutePath, { recursive: true });
    status = 204;
  }

  return new Response(body, {
    status,
    headers,
  });
}

export default {
  fetch: local,
};
