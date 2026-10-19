/**
 * A TCP connection with `node:net`, with reads of a number of bytes.
 */

import { connect } from "node:net";

/** An error of the connection, for example a timeout. */
export class ConnectionError extends Error {}

/** A TCP connection that reads a number of bytes at a time. */
export class Connection {
  /** @type {import("node:net").Socket} */
  #socket;
  /** @type {Uint8Array[]} */
  #chunks = [];
  #length = 0;
  /** @type {Error | null} */
  #error = null;
  #ended = false;
  /** @type {(() => void) | null} */
  #wake = null;

  /** @param {import("node:net").Socket} socket */
  constructor(socket) {
    this.#socket = socket;
    socket.on("data", (chunk) => {
      this.#chunks.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length),
      );
      this.#length += chunk.length;
      // Too much data that nobody reads stops the reads of the socket.
      if (this.#length > 1 << 20) socket.pause();
      this.#notify();
    });
    socket.on("end", () => {
      this.#ended = true;
      this.#notify();
    });
    socket.on("error", (error) => {
      this.#error ??= new ConnectionError(error.message);
      this.#notify();
    });
    socket.on("close", () => {
      this.#ended = true;
      this.#notify();
    });
  }

  #notify() {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  /**
   * Opens a TCP connection.
   * @param {string} host
   * @param {number} port
   * @param {number} timeout The time to connect, in milliseconds.
   * @returns {Promise<Connection>}
   * @throws {ConnectionError}
   */
  static open(host, port, timeout) {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port, noDelay: true });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new ConnectionError(`The connection to ${host}:${port} timed out`),
        );
      }, timeout);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(new Connection(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new ConnectionError(error.message));
      });
    });
  }

  /**
   * Reads a number of bytes.
   * @param {number} size
   * @returns {Promise<Uint8Array>}
   * @throws {ConnectionError} When the connection closes before.
   */
  async read(size) {
    while (this.#length < size) {
      if (this.#error) throw this.#error;
      if (this.#ended) {
        throw new ConnectionError("The server closed the connection");
      }
      this.#socket.resume();
      await new Promise((resolve) => this.#wake = resolve);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunk = this.#chunks[0];
      const count = Math.min(chunk.length, size - offset);
      bytes.set(chunk.subarray(0, count), offset);
      offset += count;
      if (count === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(count);
    }
    this.#length -= size;
    if (this.#length < 1 << 19) this.#socket.resume();
    return bytes;
  }

  /**
   * Reads a line that ends with LF, with no CR and no LF.
   * @param {number} max The largest number of bytes of the line.
   * @returns {Promise<Uint8Array>}
   */
  async readLine(max) {
    /** @type {number[]} */
    const line = [];
    while (true) {
      const [byte] = await this.read(1);
      if (byte === 0x0a) break;
      line.push(byte);
      if (line.length > max) throw new ConnectionError("A line is too long");
    }
    if (line.at(-1) === 0x0d) line.pop();
    return Uint8Array.from(line);
  }

  /**
   * Writes bytes. It waits only when the socket has too many bytes to send.
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   */
  async write(bytes) {
    if (this.#error) throw this.#error;
    if (this.#ended) throw new ConnectionError("The connection is closed");
    if (this.#socket.write(bytes)) return;
    await new Promise((resolve) => {
      const done = () => {
        this.#socket.off("drain", done);
        this.#socket.off("close", done);
        resolve(undefined);
      };
      this.#socket.on("drain", done);
      this.#socket.on("close", done);
    });
    if (this.#error) throw this.#error;
  }

  /**
   * Tells if the connection keeps the process of Node.js running. An idle
   * connection of a pool does not.
   * @param {boolean} active
   */
  setActive(active) {
    if (active) this.#socket.ref?.();
    else this.#socket.unref?.();
  }

  /** Closes the connection. */
  close() {
    this.#ended = true;
    this.#socket.destroy();
    this.#notify();
  }
}
