import { basename, join, toLocaleISOString } from "../../deps.ts";

import { File } from "../../main.ts";

type Options = Record<string, string>;

const encoder = new TextEncoder();

/**
 * List directories and objects in the path in JSON format.
 *
 * The output is an array of Items, where each Item looks like this
 *
 * ```json
 * {
 *   "Hashes" : {
 *     "SHA-1" : "f572d396fae9206628714fb2ce00f72e94f2258f",
 *     "MD5" : "b1946ac92492d2347c6235b4d2611184",
 *     "DropboxHash" : "ecb65bb98f9d905b70458986c39fcbad7715e5f2fcc3b1f07767d7c83e2438cc"
 *   },
 *   "ID": "y2djkhiujf83u33",
 *   "OrigID": "UYOJVTUW00Q1RzTDA",
 *   "IsBucket" : false,
 *   "IsDir" : false,
 *   "MimeType" : "application/octet-stream",
 *   "ModTime" : "2017-05-31T16:15:57.034468261+01:00",
 *   "Name" : "file.txt",
 *   "Encrypted" : "v0qpsdq8anpci8n929v3uu9338",
 *   "EncryptedPath" : "kja9098349023498/v0qpsdq8anpci8n929v3uu9338",
 *   "Path" : "full/path/goes/here/file.txt",
 *   "Size" : 6,
 *   "Tier" : "hot",
 * }
 * ```
 *
 * The `Path` field will only show folders below the remote path being listed.
 * If "remote:path" contains the file "subfolder/file.txt", the `Path` for
 * "file.txt" will be "subfolder/file.txt", not "remote:path/subfolder/file.txt".
 * When used without `--recursive` the `Path` will always be same as `Name`.
 *
 * The whole output can be processed as a JSON blob, or alternatively it can be
 * processed line by line as each item is written one to a line.
 *
 * Note that `ls` and `lsl` recurse by default - use `--max-depth 1` to stop
 * the recursion.
 *
 * The other list commands `lsd`, `lsf`, `lsjson` do not recurse by default -
 * use `--recursive` to make them recurse.
 */
export async function lsjson(
  location: string,
  flags: Options = {},
): Promise<Response> {
  const init = { method: "HEAD" };
  const url = `${location}?${new URLSearchParams(flags)}`;
  const response = await fetch(url, init);
  const { headers, ok } = response;

  if (!ok) {
    return response;
  }

  let maxDepth = Number(flags.max_depth || (flags.recursive ? Infinity : 1));
  if (!flags.recursive) {
    maxDepth = 1;
  }

  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("["));

      const links = getLinks(headers);
      let count = 0;

      while (maxDepth > 0) {
        const nextLinks = [];

        for await (let link of links) {
          const url = `${location}/${link}?${new URLSearchParams(flags)}`;
          const { headers } = await fetch(url, init);
          const size = Number(headers.get("Content-Length"));
          const IsDir = link.endsWith("/");
          if (IsDir) {
            nextLinks.push(...getLinks(headers, link));
            link = link.slice(0, -1);
          }

          const item: Partial<File> = {
            Path: `${link}`,
            Name: basename(link),
            Size: IsDir ? -1 : size,
            MimeType: IsDir
              ? "inode/directory"
              : headers.get("Content-Type") || "",
            ModTime: toLocaleISOString(headers.get("Last-Modified")),
            IsDir,
          };

          const prefix = count == 0 ? "\n" : ",\n";
          count++;

          controller.enqueue(encoder.encode(prefix + JSON.stringify(item)));
        }

        if (!nextLinks.length) {
          break;
        }

        links.length = 0;
        links.push(...nextLinks);
        maxDepth--;
      }

      controller.enqueue(encoder.encode("\n]\n"));
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function getLinks(headers: Headers, parent = "") {
  return headers.get("Link")?.split(",").map((link) => {
    const [_, uri] = link.match(/<([^>]*)>/) || [];
    return decodeURIComponent(join(parent, uri));
  }) || [];
}
