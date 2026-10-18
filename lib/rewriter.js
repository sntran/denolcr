/**
 * HTMLRewriter for the lists of folders:
 *
 * ```js
 * const rewriter = await htmlRewriter();
 * rewriter.on("tr a[href]", { element(element) {} }).transform(response);
 * ```
 */

/**
 * The largest chunk of HTML for one write to HTMLRewriter.
 *
 * In Node.js, the HTMLRewriter of WebAssembly puts each chunk of its output in
 * the queue of a stream, and the output of one write can be thousands of
 * chunks. A read
 * from a queue of more than about 16000 chunks copies the queue, thus a list
 * in one large chunk takes a quadratic time. A write of at most 8 KiB gives
 * at most about 8192 chunks of output, which is less than that limit:
 * HTMLRewriter starts the next write when the reader has read the queue.
 *
 * Each chunk also costs much time in the streams of Node.js, thus the small
 * chunks, for example the output of another HTMLRewriter, become one write.
 *
 * The HTMLRewriter of workerd and of Bun is a part of the runtime, with no
 * such queue: it gets the chunks as they come, because a stream of
 * JavaScript between two of them costs more time.
 */
export const CHUNK = 8 * 1024;

/**
 * Gives the bytes of a stream in chunks of at most `CHUNK` bytes. It cuts a
 * large chunk, and joins the small chunks that come one after the other.
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {ReadableStream<Uint8Array>}
 */
export function inChunks(stream) {
  /** The small chunks that are not written yet. @type {Uint8Array[]} */
  let held = [];
  let size = 0;
  /** @param {TransformStreamDefaultController<Uint8Array>} controller */
  const write = (controller) => {
    if (size > 0) {
      let joined = held[0];
      if (held.length > 1) {
        joined = new Uint8Array(size);
        let offset = 0;
        for (const chunk of held) {
          joined.set(chunk, offset);
          offset += chunk.length;
        }
      }
      controller.enqueue(joined);
    }
    held = [];
    size = 0;
  };
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (chunk.length === 0) return;
        if (size + chunk.length <= CHUNK) {
          held.push(chunk);
          size += chunk.length;
          return;
        }
        write(controller);
        let start = 0;
        for (; chunk.length - start > CHUNK; start += CHUNK) {
          controller.enqueue(chunk.subarray(start, start + CHUNK));
        }
        held.push(chunk.subarray(start));
        size = chunk.length - start;
      },
      flush: write,
    }),
  );
}

/**
 * The class HTMLRewriter, at its first use: in Node.js, its load takes much
 * time, and a command that reads no list does not need it.
 * @type {Promise<typeof import("@sntran/html-rewriter").HTMLRewriter> | undefined}
 */
let loaded;

/** True when HTMLRewriter is the HTMLRewriter of the runtime. */
let native = false;

/**
 * An HTMLRewriter. The HTMLRewriter of WebAssembly gets the HTML in chunks of
 * at most `CHUNK` bytes.
 */
class Rewriter {
  /** @type {import("@sntran/html-rewriter").HTMLRewriter} */
  #rewriter;

  /** @param {import("@sntran/html-rewriter").HTMLRewriter} rewriter */
  constructor(rewriter) {
    this.#rewriter = rewriter;
  }

  /**
   * @param {string} selector
   * @param {import("@sntran/html-rewriter").ElementHandlers} handlers
   * @returns {this}
   */
  on(selector, handlers) {
    this.#rewriter.on(selector, handlers);
    return this;
  }

  /**
   * @param {Response} response
   * @returns {Response}
   */
  transform(response) {
    if (native || !response.body) return this.#rewriter.transform(response);
    return this.#rewriter.transform(
      new Response(inChunks(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    );
  }
}

/**
 * Makes a new HTMLRewriter.
 * @returns {Promise<Rewriter>}
 */
export async function htmlRewriter() {
  loaded ??= import("@sntran/html-rewriter").then((module) => {
    native = module.HTMLRewriter === globalThis.HTMLRewriter;
    return module.HTMLRewriter;
  });
  const HTMLRewriter = await loaded;
  return new Rewriter(new HTMLRewriter());
}
