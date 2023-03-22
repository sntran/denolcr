import { basename, resolve } from "../../deps.ts";

import { fetch, Options } from "../../main.ts";

/**
 * Copy url content to dest.
 *
 * Download a URL's content and copy it to the destination without saving it
 * in temporary storage.
 *
 * Setting `auto-filename` will attempt to automatically determine the
 * filename from the URL (after any redirections) and used in the destination
 * path. With `header-filename` in addition, if a specific filename is set in
 * HTTP headers, it will be used instead of the name from the URL. With
 * `print-filename` in addition, the resulting file name will be printed.
 *
 * Setting `no-clobber` will prevent overwriting file on the destination if
 * there is one with the same name.
 *
 * Setting `stdout` or making the output file name `-` will cause the output
 * to be written to standard output.
 */
export async function copyurl(
  url: string,
  target: string,
  flags: Options = {},
): Promise<Response> {
  const {
    "auto-filename": autoFilename,
    "header-filename": headerFilename,
    "no-clobber": noClobber,
    "print-filename": printFilename,
    "stdout": stdout,
    ...params
  } = flags;

  if (noClobber) {
    const { ok } = await fetch(target, { method: "HEAD" });
    if (ok) {
      throw new Error(`File ${target} already exists.`);
    }
  }

  const response = await fetch(url);
  const body = response.body;

  if (stdout || target === "-") {
    return new Response(body);
  }

  if (response.url) {
    url = response.url;
  }

  if (autoFilename) {
    let filename = basename(url);
    if (headerFilename) {
      const contentDisposition = response.headers.get("Content-Disposition");
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="(.*)"/);
        if (match) {
          filename = match[1];
        }
      }
    }

    if (filename) {
      if (printFilename) {
        console.log(printFilename);
      }
      target = resolve(target, filename);
    }
  }

  return fetch(`${target}?${new URLSearchParams(params)}`, {
    method: "PUT",
    body,
  });
}
