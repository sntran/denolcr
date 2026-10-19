/**
 * Reads parts of a file of a remote with the header `Range`, for example
 * the index at the end of a zip file, and then one file in the zip file.
 * Each read is one request, and the file never comes all into memory.
 */
import { sliceStream } from "./range.js";

/**
 * An answer of the remote that is not a part of the file, for example 404
 * for a file that does not exist. The backend gives this answer to its
 * client.
 */
export class RemoteError extends Error {
  /** @param {Response} response */
  constructor(response) {
    super(`The remote gave ${response.status}`);
    this.response = response;
  }
}

/** The error for a remote that sends all the file for a range. */
function noRanges() {
  return new RemoteError(
    new Response("The remote does not read a part of a file", {
      status: 501,
    }),
  );
}

/**
 * A file of a remote, read in parts.
 */
export class RangedFile {
  /**
   * The size of the file, after the first read.
   * @type {number | null}
   */
  size = null;

  /**
   * The time of the last change of the file, from `Last-Modified`.
   * @type {string | null}
   */
  lastModified = null;

  /** @type {(headers: Headers) => Promise<Response>} */
  #get;

  /**
   * @param {(headers: Headers) => Promise<Response>} get Sends a GET request
   *   of the file, with the headers, for example `Range`.
   */
  constructor(get) {
    this.#get = get;
  }

  /**
   * Sends a GET request with a range, and reads the size of the file in
   * the answer.
   * @param {string} range For example `bytes=0-99`.
   * @returns {Promise<Response>} An answer 200, 206 or 416.
   * @throws {RemoteError} For another answer.
   */
  async #range(range) {
    const response = await this.#get(new Headers({ Range: range }));
    const { status, headers } = response;
    if (status !== 200 && status !== 206 && status !== 416) {
      throw new RemoteError(response);
    }
    this.lastModified ??= headers.get("Last-Modified");
    const total = headers.get("Content-Range")?.match(/\/(\d+)\s*$/)?.[1];
    if (total !== undefined) {
      this.size = Number(total);
    } else if (status === 200 && headers.has("Content-Length")) {
      this.size = Number(headers.get("Content-Length"));
    }
    return response;
  }

  /**
   * Reads all the body of an answer 200, when it has at most `limit`
   * bytes: the remote sent all the file, and the file is small.
   * @param {Response} response
   * @param {number} limit
   */
  async #small(response, limit) {
    if (Number(response.headers.get("Content-Length") ?? 0) > limit) {
      await response.body?.cancel();
      throw noRanges();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw noRanges();
    this.size = bytes.length;
    return bytes;
  }

  /**
   * Reads the last bytes of the file.
   * @param {number} length
   * @returns {Promise<Uint8Array>} At most `length` bytes: fewer for a
   *   smaller file.
   */
  async tail(length) {
    const response = await this.#range(`bytes=-${length}`);
    if (response.status === 416) {
      await response.body?.cancel();
      this.size ??= 0;
      return new Uint8Array(0);
    }
    if (response.status === 200) {
      const bytes = await this.#small(response, length);
      return bytes;
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Reads a part of the file.
   * @param {number} offset
   * @param {number} length
   * @returns {Promise<Uint8Array>} At most `length` bytes: fewer at the end
   *   of the file.
   */
  async read(offset, length) {
    if (length <= 0) return new Uint8Array(0);
    const response = await this.#range(
      `bytes=${offset}-${offset + length - 1}`,
    );
    if (response.status === 416) {
      await response.body?.cancel();
      return new Uint8Array(0);
    }
    if (response.status === 200) {
      const bytes = await this.#small(response, offset + length);
      return bytes.subarray(offset, offset + length);
    }
    const start = Number(
      response.headers.get("Content-Range")?.match(/bytes (\d+)-/)?.[1],
    );
    if (start !== offset) {
      await response.body?.cancel();
      throw noRanges();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.subarray(0, length);
  }

  /**
   * Gives a part of the file as a stream.
   * @param {number} offset
   * @param {number} length
   * @returns {Promise<ReadableStream<Uint8Array>>} At most `length` bytes:
   *   fewer at the end of the file.
   */
  async stream(offset, length) {
    if (length <= 0) return new Blob([]).stream();
    const response = await this.#range(
      `bytes=${offset}-${offset + length - 1}`,
    );
    if (response.status === 416 || !response.body) {
      await response.body?.cancel();
      return new Blob([]).stream();
    }
    // A remote that sends all the file: the part is after `offset` bytes.
    const skip = response.status === 200 ? offset : 0;
    return sliceStream(response.body, skip, length);
  }
}
