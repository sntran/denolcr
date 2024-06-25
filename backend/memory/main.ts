#!/usr/bin/env -S deno serve --allow-all

/**
 * Memory Backend
 *
 * The memory backend is an in RAM backend. It does not persist its data - use
 * the local backend for that.
 *
 * Because it has no parameters you can just use it with the `:memory:` remote
 * name.
 */
import { contentType, extname, formatBytes } from "../../deps.ts";

const cache: Map<string, File | null> = new Map();
// Creates the root folder.
cache.set("/", null);

async function router(request: Request): Promise<Response> {
  const { method, url } = request;
  const { pathname, searchParams } = new URL(url);

  const headers = new Headers();
  let status = 200, body = null;

  if (method === "GET") {
    // Retrieves file content.
    for (const [key, value] of cache) {
      if (key === pathname) {
        // File.
        if (value !== null) {
          body = value.stream();
          break;
        }

        const regex = new RegExp(pathname + "([^/]+/?)");
        const children: string[] = [];
        for (const key of cache.keys()) {
          const [, child] = key.match(regex) || [];
          if (child) {
            if (!children.includes(child)) {
              children.push(child);
            }
          }
        }

        children.sort((a, b) => a.localeCompare(b));

        // Folder listing
        body = new ReadableStream({
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

            for (const name of children) {
              const value = cache.get(pathname + name);
              const isDirectory = value === null;

              let filePath = name;
              if (isDirectory) {
                filePath += "/";
              }

              const type = isDirectory
                ? ""
                : contentType(extname(pathname)) || "";
              const size = Number(isDirectory ? "-1" : value!.size);
              const lastModified = value?.lastModified
                ? new Date(value?.lastModified)
                : "";

              controller.enqueue(`<tr>
                <td>${isDirectory ? "📁" : "📄"}</td>
                <td>
                  <a
                    href="${filePath}?${searchParams}"
                    type="${type}"
                  >${name}</a>
                </td>
                <td>
                  ${
                size
                  ? `<data
                        value="${size}"
                      >${formatBytes(size, { locale: true })}</data>`
                  : "—"
              }
                </td>
                <td>${
                lastModified
                  ? `<time
                      datetime="${lastModified.toISOString()}"
                    >${lastModified.toLocaleString()}</time>`
                  : "-"
              }
                </td>
              </tr>`);
            }

            controller.enqueue("</tbody></table>");
            controller.close();
          },
        }).pipeThrough(new TextEncoderStream());

        headers.set("Content-Type", "text/html;charset=utf-8");

        break;
      }
    }

    if (!body) {
      status = 404;
    }
  }

  if (method === "PUT") {
    const folders = pathname.split("/").slice(1, -1);
    // Creates ancestor folders, recursively.
    let href = "/";
    for (const segment of folders) {
      href += `${segment}/`;
      cache.set(`${href}`, null);
    }

    // Folder ending with trailing slash.
    if (pathname.endsWith("/")) {
      // Nothing, as we already created it.
    } else {
      // Creates file.
      const file = new File([await request.arrayBuffer()], pathname, {
        type: request.headers.get("Content-Type") || "",
        lastModified: Date.now(),
      });
      cache.set(pathname, file);
    }

    status = 201;
    headers.append("Content-Location", pathname);
  }

  if (method === "DELETE") {
    // Folder ending with trailing slash.
    if (pathname.endsWith("/")) {
      // Deletes files in that folder.
      for (const key of cache.keys()) {
        if (key.startsWith(pathname)) {
          cache.delete(key);
        }
      }
      // Deletes the folder itself
      cache.delete(pathname);
    } else {
      // Deletes file.
      cache.delete(pathname);
    }
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
