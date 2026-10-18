/**
 * The ranges of bytes of a file, as RFC 9110 (section 14): the header
 * `Range: bytes=START-END` of a GET request, and the answer 206 with
 * `Content-Range`, or 416 when no byte of the file is in the range.
 *
 * Only one range is supported. A server can send all the file for a
 * request with more ranges, or with a range that it cannot read.
 */

/**
 * Reads the range of a request, for a file of a size.
 * @param {string | null} header The value of `Range`, for example
 *   `bytes=0-99`, `bytes=100-` or `bytes=-100`.
 * @param {number} size The size of the file.
 * @returns {{ start: number, end: number } | null} The first byte and the
 *   last byte, or null to send all the file: for no range, for more ranges,
 *   and for a range that is not correct.
 * @throws {RangeError} When no byte of the file is in the range. Then the
 *   answer is 416.
 */
export function parseRange(header, size) {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  const [, first, last] = match;

  if (first === "") {
    // The last bytes of the file.
    if (last === "") return null;
    const length = Number(last);
    if (length === 0 || size === 0) {
      throw new RangeError("Range Not Satisfiable");
    }
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (last !== "" && Number(last) < start) return null;
  if (start >= size) throw new RangeError("Range Not Satisfiable");
  return { start, end };
}

/**
 * The headers of an answer 206, for a range of a file.
 * @param {{ start: number, end: number }} range
 * @param {number} size The size of the file.
 * @returns {Record<string, string>}
 */
export function partialHeaders({ start, end }, size) {
  return {
    "Content-Range": `bytes ${start}-${end}/${size}`,
    "Content-Length": `${end - start + 1}`,
  };
}

/**
 * The answer 416, when no byte of the file is in the range.
 * @param {number} size The size of the file.
 * @returns {Response}
 */
export function notSatisfiable(size) {
  return new Response(null, {
    status: 416,
    headers: { "Content-Range": `bytes */${size}` },
  });
}

/**
 * Gives a part of a stream: the bytes after the first `skip` bytes, at most
 * `length` bytes. It cancels the stream after the part.
 * @param {ReadableStream<Uint8Array>} stream
 * @param {number} skip
 * @param {number} length
 * @returns {ReadableStream<Uint8Array>}
 */
export function sliceStream(stream, skip, length) {
  const reader = stream.getReader();
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (length <= 0) {
          controller.close();
          await reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        let chunk = value;
        if (skip > 0) {
          const dropped = Math.min(skip, chunk.length);
          skip -= dropped;
          chunk = chunk.subarray(dropped);
        }
        if (chunk.length === 0) continue;
        if (chunk.length > length) chunk = chunk.subarray(0, length);
        length -= chunk.length;
        controller.enqueue(chunk);
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
