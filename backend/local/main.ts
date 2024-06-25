#!/usr/bin/env -S deno serve --allow-all

import { contentType, extname, formatBytes, join } from "../../deps.ts";

const cwd = Deno.cwd();

/** Main export */
async function router(request: Request): Promise<Response> {
  const { method, url } = request;
  const { pathname, searchParams } = new URL(url);
  const absolutePath = join(cwd, pathname);

  let stats;

  const headers = new Headers();
  let status = 200, body = null;

  if (method === "HEAD" || method === "GET") {
    const file = await Deno.open(absolutePath);
    stats = await file.stat();
    file.close();

    if (stats.isDirectory) {
      const files: Deno.DirEntry[] = [];
      for await (const file of Deno.readDir(absolutePath)) {
        const { name, isDirectory } = file;
        let filePath = name;
        if (isDirectory) {
          filePath += "/";
        }
        files.push(file);
      }

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

            for await (const { name, isDirectory } of files) {
              let filePath = name;
              if (isDirectory) {
                filePath += "/";
              }

              const { size, mtime } = await Deno.stat(
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
        const file = await Deno.open(absolutePath);
        body = file.readable;
      }
    }

    const mtime = stats.mtime?.toUTCString();
    if (mtime) headers.append("Last-Modified", mtime);
  }

  /** `PUT` upserts a file at `pathname`. */
  if (method === "PUT") {
    // Folder ending with trailing slash.
    if (pathname.endsWith("/")) {
      await Deno.mkdir(absolutePath, { recursive: true });
    } else {
      const file = await Deno.open(absolutePath, { write: true, create: true });
      await request.body!.pipeTo(file.writable);
    }

    status = 201;
    headers.append("Content-Location", pathname);
  }

  if (method === "DELETE") {
    await Deno.remove(absolutePath, { recursive: true });
    status = 204;
  }

  return new Response(body, {
    status,
    headers,
  });
}

export default {
  fetch: router,
};
