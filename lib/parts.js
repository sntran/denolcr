/**
 * Cuts a stream into parts of a size, for the uploads in parts of s3 and
 * azureblob.
 */

/**
 * Cuts a stream into parts of a size: each part has the size, but the last
 * part can be smaller.
 */
export class Parts {
  /** @param {ReadableStream<Uint8Array>} stream @param {number} size */
  constructor(stream, size) {
    this.reader = stream.getReader();
    this.size = size;
    /** @type {Uint8Array} */
    this.pending = new Uint8Array(0);
    /** True when the stream has no more data. */
    this.done = false;
  }

  /**
   * The next part, or null at the end.
   * @returns {Promise<Uint8Array | null>}
   */
  async next() {
    const chunks = this.pending.length ? [this.pending] : [];
    let length = this.pending.length;
    this.pending = new Uint8Array(0);
    while (length < this.size && !this.done) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      chunks.push(value);
      length += value.length;
    }
    if (length === 0 && this.done) return null;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (length > this.size) {
      this.pending = bytes.slice(this.size);
      return bytes.subarray(0, this.size);
    }
    // A part of the size can be the last part: the next read tells it.
    if (!this.done && this.pending.length === 0) {
      const { done, value } = await this.reader.read();
      if (done) this.done = true;
      else this.pending = value;
    }
    return bytes;
  }
}
