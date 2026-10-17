/**
 * Gives a stream with a known size for the body of a response. In a Worker,
 * the response of a stream has no Content-Length, unless the stream is a
 * `FixedLengthStream`, which also makes an error when the stream has a
 * different size. Other runtimes keep the Content-Length header, thus the
 * stream does not change there.
 * @param {ReadableStream<Uint8Array>} stream
 * @param {number} size
 * @returns {ReadableStream<Uint8Array>}
 */
export function sized(stream, size) {
  const { FixedLengthStream } = globalThis;
  return FixedLengthStream
    ? stream.pipeThrough(new FixedLengthStream(size))
    : stream;
}
