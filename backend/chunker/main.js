#!/usr/bin/env -S deno serve --allow-all

/**
 * Chunker
 *
 * The chunker overlay transparently splits large files into smaller chunks
 * during upload to wrapped remote and transparently assembles them back when
 * the file is downloaded. This allows to effectively overcome size limits
 * imposed by storage providers.
 *
 * ## Chunking
 *
 * When rclone starts a file upload, chunker checks the file size. If it
 * doesn't exceed the configured chunk size, chunker will just pass the file to
 * the wrapped remote. If a file is large, chunker will transparently cut data
 * in pieces with temporary names and stream them one by one, on the fly. Each
 * data chunk will contain the specified number of bytes, except for the last
 * one which may have less data. If file size is unknown in advance (this is
 * called a streaming upload), chunker will internally create a temporary copy,
 * record its size and repeat the above process.
 *
 * When upload completes, temporary chunk files are finally renamed. This
 * scheme guarantees that operations can be run in parallel and look from
 * outside as atomic. A similar method with hidden temporary chunks is used for
 * other operations (copy/move/rename, etc.). If an operation fails, hidden
 * chunks are normally destroyed, and the target composite file stays intact.
 *
 * When a composite file download is requested, chunker transparently assembles
 * it by concatenating data chunks in order. As the split is trivial one could
 * even manually concatenate data chunks together to obtain the original
 * content.
 *
 * When the `list` rclone command scans a directory on wrapped remote, the
 * potential chunk files are accounted for, grouped and assembled into
 * composite directory entries. Any temporary chunks are hidden.
 *
 * List and other commands can sometimes come across composite files with
 * missing or invalid chunks, e.g. shadowed by like-named directory or another
 * file. This usually means that wrapped file system has been directly tampered
 * with or damaged. If chunker detects a missing chunk it will by default print
 * warning, skip the whole incomplete group of chunks but proceed with current
 * command. You can set the `--chunker-fail-hard` flag to have commands abort
 * with error message in such cases.
 *
 * ### Chunk names
 *
 * The default chunk name format is `*.rclone_chunk.###`, hence by default
 * chunk names are `BIG_FILE_NAME.rclone_chunk.001`, etc. You can configure
 * another name format using the `name_format` configuration file option. The
 * format uses asterisk `*` as a placeholder for the base file name and one or
 * more consecutive hash characters `#` as a placeholder for sequential chunk
 * number. There must be one and only one asterisk. The number of consecutive
 * hash characters defines the minimum length of a string representing a chunk
 * number. If decimal chunk number has less digits than the number of hashes,
 * it is left-padded by zeros. If the decimal string is longer, it is left
 * intact. By default numbering starts from 1 but there is another option that
 * allows user to start from 0, e.g. for compatibility with legacy software.
 *
 * For example, if name format is `big_*-##.part` and original file name is
 * `data.txt` and numbering starts from 0, then the first chunk will be named
 * `big_data.txt-00.part`, the 99th chunk will be `big_data.txt-98.part` and
 * the 302nd chunk will become `big_data.txt-301.part`.
 *
 * Note that `list` assembles composite directory entries only when chunk names
 * match the configured format and treats non-conforming file names as normal
 * non-chunked files.
 *
 * When using `norename` transactions, chunk names will additionally have a
 * unique file version suffix. For example, `BIG_FILE.rclone_chunk.001_bp562k`.
 *
 * ## Metadata
 *
 * Besides data chunks chunker will by default create metadata object for a
 * composite file. The object is named after the original file. Chunker allows
 * user to disable metadata completely (the `none` format). Note that metadata
 * is normally not created for files smaller than the configured chunk size.
 * This may change in future rclone releases.
 *
 * ### Simple JSON metadata format
 *
 * This is the default format. It supports hash sums and chunk validation for
 * composite files. Meta objects carry the following fields:
 *
 * - `ver` - version of format, currently `1`
 * - `size` - total size of composite file
 * - `nchunks` - number of data chunks in file
 * - `md5` - MD5 hashsum of composite file (if present)
 * - `sha1` - SHA1 hashsum (if present)
 * - `txn` - identifies current version of the file
 *
 * There is no field for composite file name as it's simply equal to the name
 * of meta object on the wrapped remote. Please refer to respective sections
 * for details on hashsums and modified time handling.
 *
 * ### No metadata
 *
 * You can disable meta objects by setting the meta format option to `none`. In
 * this mode chunker will scan directory for all files that follow configured
 * chunk name format, group them by detecting chunks with the same base name
 * and show group names as virtual composite files. This method is more prone
 * to missing chunk errors (especially missing last chunk) than format with
 * metadata enabled.
 */
import { crypto, encodeHex } from "../../deps.js";
import { Chunker } from "../../lib/streams/chunker.js";
import { fetch } from "../../main.js";

const METADATA_VERSION = 1;

/**
 * @typedef {Object} Metadata
 * @property {number} ver - version of format
 * @property {number} size - total size of composite file
 * @property {number} nchunks - number of data chunks in file
 * @property {string} [md5] - MD5 hashsum of composite file
 * @property {string} [sha1] - SHA1 hashsum
 * @property {number} [txn] - identifies current version of the file
 */

export const options = {
  string: [
    "hash_type",
    "name_format",
    "meta_format",
    /**
     * Remote to chunk/unchunk.
     * Normally should contain a ':' and a path, e.g."myremote:path/to/dir",
     * "myremote:bucket" or maybe "myremote:" (not recommended).
     */
    "remote",
    "transactions",
  ],
  boolean: ["fail_hard"],
  default: {
    chunk_size: 2 * 1024 * 1024 * 1024, // 2 GiB
    hash_type: "md5", // | "sha1" | "md5all" | "sha1all" | "md5quick" | "sha1quick" | "none"
    meta_format: "simplejson", // | "none"
    name_format: "*.rclone_chunk.###",
    start_from: 1,
    transactions: "rename", // | "norename" | "auto"
  },
};

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function router(request) {
  const { method, url } = request;
  const { pathname, searchParams } = new URL(url);

  const remote = searchParams.get("remote");
  if (!remote) {
    throw new Error("Missing remote");
  }
  const chunkSize = Number(searchParams.get("chunk_size")) ||
    options.default.chunk_size;
  const nameFormat = searchParams.get("name_format") ||
    options.default.name_format;
  const startFrom = Number(
    searchParams.get("start_from") || options.default.start_from,
  );
  const metaFormat = searchParams.get("meta_format") ||
    options.default.meta_format;
  // const failHard = searchParams.get("fail_hard") !== "false";
  // const transactions = searchParams.get("transactions") ||
  //   options.default.transactions;

  if (startFrom < 0) {
    throw new Error("start_from must be non-negative");
  }

  const headers = new Headers();
  let status = 200, body = null;

  const fileName = pathname.split("/").pop();

  if (method === "GET") {
    // Gets the file from the remote. This file can be the metadata file or the
    // original file, either size should not be greater than the chunk size.
    const response = await fetch(`${remote}/${fileName}`);

    // Responds immediately if meta_format is none.
    if (metaFormat === "none") {
      return new Response(response.body, {
        status,
        headers,
      });
    }

    // Otherwise, the response should be less than or equal to the chunk size.
    body = await response.arrayBuffer();

    try {
      // TODO: better way to handle this? Parsing a 2GB file is not ideal.
      /**
       * @type {Metadata}
       */
      const { size, nchunks } = JSON.parse(
        new TextDecoder().decode(body),
      );

      headers.set("Content-Length", size.toString());

      body = new ReadableStream({
        async start(controller) {
          let bytesProcessed = 0;
          for (let i = startFrom; i < nchunks + startFrom; i++) {
            const chunkName = formatName(fileName, i, nameFormat);
            const { body } = await fetch(`${remote}/${chunkName}`);
            const reader = body.getReader();

            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              controller.enqueue(value);
              bytesProcessed += value.byteLength;
              if (bytesProcessed >= size) {
                break;
              }
            }

            reader.releaseLock();

            if (bytesProcessed >= size) {
              break;
            }
          }

          controller.close();
        },
      })
        .pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(chunk);
            },
          }),
        );
    } catch (_error) { // Not a metadata file.
    }
  }

  if (method === "PUT") {
    let chunkIndex = startFrom;
    let fileSize = 0;

    const streams = metaFormat === "none" ? [request.body] : request.body.tee();
    const digestStream = streams[1] && crypto.subtle.digest("MD5", streams[1]);

    /**
     * @type {Uint8Array}
     */
    let previousChunk;

    body = streams[0]
      .pipeThrough(new Chunker(chunkSize))
      .pipeThrough(
        new TransformStream({
          async transform(chunk) {
            // In order to handle the last chunk, which is unknown in advance,
            // we delay the upload by 1 iteration. The current iteration will
            // upload the previous chunk, and let the flush() method upload the
            // last chunk.
            if (previousChunk) {
              const chunkName = formatName(
                fileName,
                chunkIndex - 1,
                nameFormat,
              );
              await upload(`${remote}/${chunkName}`, {
                body: previousChunk,
              });
            }

            previousChunk = chunk;
            fileSize += chunk.length;
            chunkIndex++;
          },
          // Finalizes the upload.
          async flush() {
            const chunked = fileSize > chunkSize;
            // Uploads the last chunk here so we can control the file name whether
            // the file is chunked or not.
            if (previousChunk) {
              const chunkName = chunked
                ? formatName(fileName, chunkIndex - 1, nameFormat)
                : fileName;
              await upload(`${remote}/${chunkName}`, {
                body: previousChunk,
              });
            }

            // Skips if there is no metadata to upload.
            if (!streams[1] || !chunked) {
              return;
            }

            /**
             * @type {Metadata}
             */
            const metadata = {
              ver: METADATA_VERSION,
              size: fileSize,
              nchunks: chunkIndex - startFrom,
              md5: encodeHex(await digestStream),
            };
            // Adds metadata.
            await fetch(`${remote}/${fileName}`, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json; charset=UTF-8",
              },
              body: JSON.stringify(metadata),
            });
          },
        }),
      );

    status = 201;
    headers.append("Content-Location", pathname);
  }

  return new Response(body, {
    status,
    headers,
  });
}

/**
 * Formats a chunk name
 *
 * The format uses `*` as a placeholder for the base file name and
 * one or more consecutive hash characters `#` as a placeholder for
 * sequential chunk number. There must be one and only one asterisk.
 * The number of consecutive hash characters defines the minimum
 * length of a string representing a chunk number. If decimal chunk
 * number has less digits than the number of hashes, it is
 * left-padded by zeros. If the decimal string is longer, it is left
 * intact. By default numbering starts from 1 but there is another
 * option that allows user to start from 0, e.g. for compatibility
 * with legacy software.
 *
 * For example, if name format is `big_*-##.part` and original file
 * name is `data.txt` and numbering starts from 0, then the first
 * chunk will be named `big_data.txt-00.part`, the 99th chunk will be
 * `big_data.txt-98.part` and the 302nd chunk will become
 * `big_data.txt-301.part`.
 *
 * @param {string} name - base file name
 * @param {number} index - chunk number
 * @param {string} format - format to use
 * @returns {string} formatted name
 */
function formatName(name, index, format) {
  return format.replace("*", name).replace(/([#])\1+/g, (hashes) => {
    return `${index}`.padStart(hashes.length, "0");
  });
}

/**
 * @param {string | URL} url
 * @param {RequestInit} init
 * @returns
 */
async function upload(url, init) {
  const { headers, body } = init;
  // Skips the chunk if it already exists.
  const response = await fetch(url, {
    method: "HEAD",
    headers,
  });
  if (response.ok) {
    //   return;
  }

  // Sends the chunk to underlying remote.
  return fetch(url, {
    method: "PUT",
    headers,
    body,
  });
}

export default {
  fetch: router,
};
