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
   * The next part, or null at the end. A part can be a view of a chunk of
   * the stream: a large chunk is not copied for each part.
   * @returns {Promise<Uint8Array | null>}
   */
  async next() {
    /** @type {Uint8Array[]} */
    const chunks = [];
    let length = 0;
    // The chunks before the last chunk of the part.
    while (length + this.pending.length < this.size && !this.done) {
      if (this.pending.length) {
        chunks.push(this.pending);
        length += this.pending.length;
        this.pending = new Uint8Array(0);
      }
      const { done, value } = await this.reader.read();
      if (done) this.done = true;
      else this.pending = value;
    }
    const take = Math.min(this.size - length, this.pending.length);
    if (take > 0) {
      chunks.push(this.pending.subarray(0, take));
      length += take;
      this.pending = this.pending.subarray(take);
    }
    if (length === 0) return null;
    let bytes = chunks[0];
    if (chunks.length > 1) {
      bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    }
    // A part of the size can be the last part: the next read tells it.
    while (!this.done && this.pending.length === 0) {
      const { done, value } = await this.reader.read();
      if (done) this.done = true;
      else this.pending = value;
    }
    return bytes;
  }
}
