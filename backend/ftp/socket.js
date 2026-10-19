/**
 * The TCP connections of FTP, with or without TLS. In Node.js, Deno and
 * Bun, the connections are of `node:net` and `node:tls`. In workerd, they
 * are of `cloudflare:sockets`: the TLS of `node:tls` cannot start on a
 * connection of `node:net` there, and `AUTH TLS` of FTP needs that.
 *
 * A connection reads only when its user asks for data: TLS can start in
 * workerd only when no read waits.
 */

/** An error of a connection, for example a timeout. */
export class ConnectionError extends Error {}

/** True in workerd, the runtime of Cloudflare Workers. */
export const WORKERD = globalThis.navigator?.userAgent === "Cloudflare-Workers";

/**
 * The options of a connection.
 * @typedef {Object} ConnectOptions
 * @property {string} host
 * @property {number} port
 * @property {boolean} [tls] True for TLS from the start.
 * @property {boolean} [startTls] True for TLS later, with `startTls()`.
 * @property {boolean} [checkCertificate] False for no check of the
 *   certificate, only in Node.js, Deno and Bun.
 * @property {boolean} [disableTls13] TLS 1.2 at most, only in Node.js, Deno
 *   and Bun.
 * @property {unknown} [session] A TLS session to resume, of `node:tls`.
 * @property {number} [timeout] The time to connect, in milliseconds.
 */

/**
 * The connection of a runtime.
 * @typedef {Object} Transport
 * @property {(options: ConnectOptions) => Promise<void>} open
 * @property {() => Promise<Uint8Array | null>} read The next chunk, or
 *   null at the end.
 * @property {(bytes: Uint8Array) => Promise<void>} write
 * @property {(options: ConnectOptions) => Promise<void>} startTls
 * @property {unknown} session
 * @property {boolean} ended True when the server closed the connection.
 * @property {(active: boolean) => void} setActive
 * @property {() => Promise<void>} end
 * @property {() => void} close
 */

/** A connection that reads lines and bytes. */
export class Connection {
  /** @type {Uint8Array} */
  #buffer = new Uint8Array(0);
  #ended = false;
  /** @type {Transport} */
  #transport;

  /** @param {Transport} transport */
  constructor(transport) {
    this.#transport = transport;
  }

  /**
   * Opens a connection.
   * @param {ConnectOptions} options
   * @returns {Promise<Connection>}
   * @throws {ConnectionError}
   */
  static async open(options) {
    const transport = WORKERD ? new WorkerTransport() : new NodeTransport();
    await transport.open(options);
    return new Connection(transport);
  }

  /**
   * Reads more data into the buffer.
   * @returns {Promise<boolean>} False at the end of the connection.
   */
  async #more() {
    if (this.#ended) return false;
    const chunk = await this.#transport.read();
    if (chunk === null) {
      this.#ended = true;
      return false;
    }
    if (this.#buffer.length === 0) this.#buffer = chunk;
    else {
      const joined = new Uint8Array(this.#buffer.length + chunk.length);
      joined.set(this.#buffer);
      joined.set(chunk, this.#buffer.length);
      this.#buffer = joined;
    }
    return true;
  }

  /**
   * Reads a line that ends with CR LF, or with LF, with no line break.
   * @param {number} max The largest number of bytes of the line.
   * @returns {Promise<string>}
   * @throws {ConnectionError} At the end of the connection.
   */
  async readLine(max) {
    let from = 0;
    while (true) {
      const at = this.#buffer.indexOf(0x0a, from);
      if (at !== -1) {
        let line = this.#buffer.subarray(0, at);
        this.#buffer = this.#buffer.subarray(at + 1);
        if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
        return new TextDecoder().decode(line);
      }
      if (this.#buffer.length > max) {
        throw new ConnectionError("A line is too long");
      }
      from = this.#buffer.length;
      if (!await this.#more()) {
        throw new ConnectionError("The server closed the connection");
      }
    }
  }

  /**
   * Reads the next bytes.
   * @returns {Promise<Uint8Array | null>} null at the end of the
   *   connection.
   */
  async read() {
    if (this.#buffer.length === 0 && !await this.#more()) return null;
    const bytes = this.#buffer;
    this.#buffer = new Uint8Array(0);
    return bytes;
  }

  /**
   * Writes bytes, or a text in UTF-8.
   * @param {Uint8Array | string} data
   */
  async write(data) {
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data;
    await this.#transport.write(bytes);
  }

  /**
   * Starts TLS on the connection, as `AUTH TLS` of FTP.
   * @param {ConnectOptions} options
   */
  async startTls(options) {
    if (this.#buffer.length > 0) {
      throw new ConnectionError("The server sent data before TLS");
    }
    await this.#transport.startTls(options);
  }

  /** The TLS session, to resume it on another connection. */
  get session() {
    return this.#transport.session;
  }

  /**
   * True when the connection ended, maybe with data that nobody read, for
   * example `421` before the server closes an idle connection.
   */
  get ended() {
    return this.#ended || this.#transport.ended;
  }

  /**
   * Tells if the connection keeps the process of Node.js running.
   * @param {boolean} active
   */
  setActive(active) {
    this.#transport.setActive(active);
  }

  /** Ends the writes of the connection: the server sees the end. */
  async end() {
    await this.#transport.end();
  }

  /** Closes the connection. */
  close() {
    this.#ended = true;
    this.#transport.close();
  }
}

/** A connection of `node:net` and `node:tls`. */
class NodeTransport {
  /** @type {any} */
  #socket = null;
  /** @type {Uint8Array[]} */
  #chunks = [];
  #queued = 0;
  #ended = false;
  /** @type {Error | null} */
  #error = null;
  /** @type {(() => void) | null} */
  #wake = null;
  /** @type {unknown} */
  session = undefined;

  get ended() {
    return this.#ended || this.#error !== null;
  }

  /** @param {ConnectOptions} options */
  async open(options) {
    const net = await import("node:net");
    const tls = await import("node:tls");
    const { host, port, timeout = 60000 } = options;
    const socket = options.tls
      ? tls.connect({
        host,
        port,
        servername: isIP(host) ? undefined : host,
        rejectUnauthorized: options.checkCertificate !== false,
        session: /** @type {any} */ (options.session),
        ...(options.disableTls13 ? { maxVersion: "TLSv1.2" } : {}),
      })
      : net.connect({ host, port, noDelay: true });
    await this.#ready(
      socket,
      options.tls ? "secureConnect" : "connect",
      timeout,
    );
    this.#listen(socket);
  }

  /**
   * Waits until a socket connects.
   * @param {any} socket
   * @param {string} event
   * @param {number} timeout
   */
  #ready(socket, event, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ConnectionError("The connection timed out"));
      }, timeout);
      socket.once(event, () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(undefined);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new ConnectionError(error.message));
      });
    });
  }

  /** @param {any} socket */
  #listen(socket) {
    this.#socket = socket;
    socket.on("data", (chunk) => {
      this.#chunks.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length),
      );
      this.#queued += chunk.length;
      // Too much data that nobody reads stops the reads of the socket.
      if (this.#queued > 1 << 20) socket.pause();
      this.#notify();
    });
    socket.on("end", () => {
      this.#ended = true;
      this.#notify();
    });
    socket.on("close", () => {
      this.#ended = true;
      this.#notify();
    });
    socket.on("error", (error) => {
      this.#error ??= new ConnectionError(error.message);
      this.#notify();
    });
    socket.on("session", (session) => this.session = session);
  }

  #notify() {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async read() {
    while (this.#chunks.length === 0) {
      if (this.#error) throw this.#error;
      if (this.#ended) return null;
      this.#socket.resume();
      await new Promise((resolve) => this.#wake = resolve);
    }
    const chunk = /** @type {Uint8Array} */ (this.#chunks.shift());
    this.#queued -= chunk.length;
    if (this.#queued < 1 << 19) this.#socket.resume();
    return chunk;
  }

  /** @param {Uint8Array} bytes */
  async write(bytes) {
    if (this.#error) throw this.#error;
    const socket = this.#socket;
    if (socket.write(bytes)) return;
    await new Promise((resolve) => {
      const done = () => {
        socket.off("drain", done);
        socket.off("close", done);
        resolve(undefined);
      };
      socket.on("drain", done);
      socket.on("close", done);
    });
    if (this.#error) throw this.#error;
  }

  /** @param {ConnectOptions} options */
  async startTls(options) {
    const tls = await import("node:tls");
    const plain = this.#socket;
    for (const event of ["data", "end", "close", "error", "session"]) {
      plain.removeAllListeners(event);
    }
    const socket = tls.connect({
      socket: plain,
      servername: isIP(options.host) ? undefined : options.host,
      rejectUnauthorized: options.checkCertificate !== false,
      ...(options.disableTls13 ? { maxVersion: "TLSv1.2" } : {}),
    });
    await this.#ready(socket, "secureConnect", options.timeout ?? 60000);
    this.#listen(socket);
  }

  /** @param {boolean} active */
  setActive(active) {
    if (active) this.#socket?.ref?.();
    else this.#socket?.unref?.();
  }

  async end() {
    await new Promise((resolve) => this.#socket.end(resolve));
  }

  close() {
    this.#socket?.destroy();
    this.#ended = true;
    this.#notify();
  }
}

/** A connection of `cloudflare:sockets`, in workerd. */
class WorkerTransport {
  /** @type {any} */
  #socket = null;
  /** @type {any} */
  #writer = null;
  /** @type {any} */
  #reader = null;
  session = undefined;
  ended = false;

  /** @param {ConnectOptions} options */
  async open(options) {
    if (options.checkCertificate === false) {
      throw new ConnectionError(
        "workerd always checks the certificate: no_check_certificate is not possible there",
      );
    }
    if (options.disableTls13) {
      throw new ConnectionError(
        "workerd chooses the version of TLS: disable_tls13 is not possible there",
      );
    }
    // @ts-ignore: a module of workerd.
    const { connect } = await import("cloudflare:sockets");
    this.#socket = connect(
      { hostname: options.host, port: options.port },
      {
        secureTransport: options.tls
          ? "on"
          : options.startTls
          ? "starttls"
          : "off",
      },
    );
    try {
      await this.#socket.opened;
    } catch (error) {
      throw new ConnectionError(error.message);
    }
    this.#writer = this.#socket.writable.getWriter();
    this.#reader = this.#socket.readable.getReader();
  }

  async read() {
    try {
      const { done, value } = await this.#reader.read();
      if (done) this.ended = true;
      return done ? null : value;
    } catch (error) {
      this.ended = true;
      throw new ConnectionError(error.message);
    }
  }

  /** @param {Uint8Array} bytes */
  async write(bytes) {
    try {
      await this.#writer.write(bytes);
    } catch (error) {
      throw new ConnectionError(error.message);
    }
  }

  /** @param {ConnectOptions} _options */
  async startTls(_options) {
    // No read waits: the locks of the streams go, and TLS starts.
    this.#reader.releaseLock();
    this.#writer.releaseLock();
    this.#socket = this.#socket.startTls();
    this.#writer = this.#socket.writable.getWriter();
    this.#reader = this.#socket.readable.getReader();
  }

  /** @param {boolean} _active */
  setActive(_active) {}

  async end() {
    await this.#writer.close().catch(() => {});
  }

  close() {
    this.ended = true;
    this.#socket?.close().catch(() => {});
  }
}

/**
 * Tells if a host is an IP address: TLS sends no name for it.
 * @param {string} host
 */
function isIP(host) {
  return /^[\d.]+$/.test(host) || host.includes(":");
}
