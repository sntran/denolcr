/**
 * A client of FTP, as RFC 959, with the passive mode (EPSV of RFC 2428, and
 * PASV), the lists and the times of RFC 3659, and TLS of RFC 4217: from the
 * start (implicit FTPS) or after `AUTH TLS` (explicit FTPS).
 */

import { Connection, ConnectionError } from "./socket.js";
import { parseLIST, parseMLSD, parseTime } from "./list.js";

/** An answer of the server that is an error, with its code. */
export class FTPError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(`${code} ${message}`);
    this.code = code;
  }
}

/** The largest line of an answer. */
const MAX_LINE = 64 * 1024;

/**
 * The options of a connection.
 * @typedef {Object} ClientOptions
 * @property {string} host
 * @property {number} port
 * @property {string} user
 * @property {string} password
 * @property {boolean} [tls] True for implicit FTPS.
 * @property {boolean} [explicitTls] True for explicit FTPS.
 * @property {boolean} [checkCertificate] False for no check of the
 *   certificate.
 * @property {boolean} [disableEpsv]
 * @property {boolean} [disableMlsd]
 * @property {boolean} [disableUtf8]
 * @property {boolean} [forceListHidden] `LIST -a` in place of MLSD.
 * @property {boolean} [writingMdtm] `MDTM` with a time sets the time of a
 *   file, as vsftpd.
 * @property {boolean} [disableTls13] TLS 1.2 at most.
 * @property {boolean} [tlsCache] False for no TLS session of the control
 *   connection on the data connections.
 * @property {number} [timeout] The time to connect, in milliseconds.
 * @property {number} [shutTimeout] The time to wait for the answer at the
 *   end of a transfer, in milliseconds. 0 is no limit.
 * @property {number} [closeTimeout] The time to wait for the answer at the
 *   end of a download, in milliseconds. 0 is no limit.
 */

/**
 * An answer of the server.
 * @typedef {{ code: number, lines: string[] }} Reply
 */

/** A connection of FTP, with the user signed in. */
export class FTPClient {
  /** @type {Connection} */
  #control;
  /** @type {ClientOptions} */
  #options;
  /** The features of the server, from FEAT, by their names in upper case. */
  /** @type {Map<string, string>} */
  features = new Map();
  /** The commands, one after the other. */
  /** @type {Promise<void>} */
  #queue = Promise.resolve();
  /** True when the connection is not in a known state. */
  broken = false;
  #epsv = true;

  /**
   * @param {Connection} control
   * @param {ClientOptions} options
   */
  constructor(control, options) {
    this.#control = control;
    this.#options = options;
    this.#epsv = !options.disableEpsv;
  }

  /**
   * Opens a connection, and signs in the user.
   * @param {ClientOptions} options
   * @returns {Promise<FTPClient>}
   * @throws {FTPError | ConnectionError}
   */
  static async connect(options) {
    const control = await Connection.open({
      host: options.host,
      port: options.port,
      tls: options.tls,
      startTls: options.explicitTls,
      checkCertificate: options.checkCertificate,
      disableTls13: options.disableTls13,
      timeout: options.timeout,
    });
    const client = new FTPClient(control, options);
    try {
      await client.#start();
    } catch (error) {
      control.close();
      throw error;
    }
    return client;
  }

  async #start() {
    expect(await this.#reply(), 220);
    if (this.#options.explicitTls) {
      expect(await this.#send("AUTH TLS"), 234);
      await this.#control.startTls({
        host: this.#options.host,
        port: this.#options.port,
        checkCertificate: this.#options.checkCertificate,
        disableTls13: this.#options.disableTls13,
        timeout: this.#options.timeout,
      });
    }
    let reply = await this.#send(`USER ${this.#options.user}`);
    if (reply.code === 331) {
      reply = await this.#send(`PASS ${this.#options.password}`);
    }
    expect(reply, 230);
    if (this.#options.tls || this.#options.explicitTls) {
      expect(await this.#send("PBSZ 0"), 200);
      expect(await this.#send("PROT P"), 200);
    }
    reply = await this.#send("FEAT");
    if (reply.code === 211) {
      for (const line of reply.lines.slice(1, -1)) {
        const text = line.trim();
        const space = text.indexOf(" ");
        const name = (space === -1 ? text : text.slice(0, space)).toUpperCase();
        this.features.set(name, space === -1 ? "" : text.slice(space + 1));
      }
    }
    if (this.features.has("UTF8") && !this.#options.disableUtf8) {
      await this.#send("OPTS UTF8 ON");
    }
    expect(await this.#send("TYPE I"), 200);
  }

  /** True when the server gives the entry of a path with MLST. */
  get mlst() {
    return this.features.has("MLST") && !this.#options.disableMlsd;
  }

  /** True when the server lists with MLSD. */
  get mlsd() {
    return this.mlst && !this.#options.forceListHidden;
  }

  /** True when the server gives the time of a file with MDTM. */
  get canGetTime() {
    return this.features.has("MDTM");
  }

  /** True when the server sets the time of a file. */
  get canSetTime() {
    return this.features.has("MFMT") ||
      Boolean(this.#options.writingMdtm && this.features.has("MDTM"));
  }

  /** True when the connection cannot take more commands. */
  get closed() {
    return this.broken || this.#control.ended;
  }

  /**
   * Reads an answer, with its lines: `123-text` up to `123 text`.
   * @returns {Promise<Reply>}
   */
  async #reply() {
    const first = await this.#control.readLine(MAX_LINE);
    const match = /^(\d{3})([ -])/.exec(first);
    if (!match) {
      this.broken = true;
      throw new ConnectionError(`The answer ${first} is not of FTP`);
    }
    const lines = [first];
    if (match[2] === "-") {
      while (true) {
        const line = await this.#control.readLine(MAX_LINE);
        lines.push(line);
        if (line.startsWith(`${match[1]} `)) break;
      }
    }
    return { code: Number(match[1]), lines };
  }

  /**
   * Sends a command, and reads its answer.
   * @param {string} command
   * @returns {Promise<Reply>}
   */
  async #send(command) {
    if (/[\r\n]/.test(command)) {
      throw new FTPError(501, "A name cannot have a line break");
    }
    await this.#control.write(`${command}\r\n`);
    return await this.#reply();
  }

  /**
   * Runs work with the control connection, after the work before it.
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  #run(work) {
    const result = this.#queue.then(async () => {
      if (this.broken) throw new ConnectionError("The connection is broken");
      try {
        return await work();
      } catch (error) {
        // An error of the connection leaves it in a state that is not known.
        if (!(error instanceof FTPError)) this.broken = true;
        throw error;
      }
    });
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Sends a command, and gives its answer. An answer of 4xx or 5xx throws.
   * @param {string} command
   * @returns {Promise<Reply>}
   */
  command(command) {
    return this.#run(async () => {
      const reply = await this.#send(command);
      if (reply.code >= 400) {
        throw new FTPError(reply.code, message(reply));
      }
      return reply;
    });
  }

  /**
   * Opens a data connection with EPSV, or with PASV. The host of PASV is
   * not used: the data connection goes to the host of the control
   * connection, as the clients of FTP do now.
   * @param {boolean} [backpressure] False for data that the client reads to
   *   its end at once, for example a list.
   * @returns {Promise<Connection>}
   */
  async #openData(backpressure = true) {
    let port = 0;
    if (this.#epsv) {
      const reply = await this.#send("EPSV");
      const match = /\(([^\d\s])\1\1(\d+)\1\)/.exec(reply.lines.at(-1) ?? "");
      if (reply.code === 229 && match) port = Number(match[2]);
      else this.#epsv = false;
    }
    if (!port) {
      const reply = await this.#send("PASV");
      const match = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(
        reply.lines.at(-1) ?? "",
      );
      if (reply.code !== 227 || !match) {
        throw new FTPError(reply.code, message(reply));
      }
      port = Number(match[5]) * 256 + Number(match[6]);
    }
    const secure = Boolean(this.#options.tls || this.#options.explicitTls);
    return await Connection.open({
      host: this.#options.host,
      port,
      tls: secure,
      checkCertificate: this.#options.checkCertificate,
      disableTls13: this.#options.disableTls13,
      // Many servers want the TLS session of the control connection.
      session: secure && this.#options.tlsCache !== false
        ? this.#control.session
        : undefined,
      timeout: this.#options.timeout,
      backpressure,
    });
  }

  /**
   * Reads the answer at the end of a transfer, for a time at most.
   * @param {number} [time] In milliseconds, 0 for no limit.
   * @returns {Promise<Reply>}
   * @throws {ConnectionError} After the time.
   */
  async #endReply(time = 0) {
    if (!time) return await this.#reply();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    try {
      return await Promise.race([
        this.#reply(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ConnectionError("The server did not end the transfer"),
              ),
            time,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs a command with a data connection: the data connection opens before
   * the command, as the passive mode needs. It closes after the answer at
   * the end of the transfer: a close before, with data to read, for example
   * a ticket of TLS 1.3, can reset the connection, and then the server can
   * lose the last bytes of an upload.
   * @template T
   * @param {string} command
   * @param {(data: Connection) => Promise<T>} transfer Reads the data to its
   *   end, or writes the data and ends the writes.
   * @param {boolean} [backpressure] False for data that the client reads to
   *   its end at once.
   * @returns {Promise<T>}
   */
  transfer(command, transfer, backpressure = true) {
    return this.#run(async () => {
      const data = await this.#openData(backpressure);
      try {
        const reply = await this.#send(command);
        if (reply.code !== 125 && reply.code !== 150) {
          throw new FTPError(reply.code, message(reply));
        }
        let result;
        try {
          result = await transfer(data);
        } catch (error) {
          // The state of the control connection is not known.
          this.broken = true;
          throw error;
        }
        const end = await this.#endReply(this.#options.shutTimeout);
        if (end.code >= 400) throw new FTPError(end.code, message(end));
        return result;
      } finally {
        data.close();
      }
    });
  }

  /**
   * Starts a download with RETR, from an offset. The control connection
   * waits until the end of the stream. A download that stops before the end
   * of the file leaves the connection broken: the server can give 426, 451
   * or 226 for it.
   * @param {string} path
   * @param {number} offset
   * @param {number} length The number of bytes to read, Infinity for all
   *   the bytes after the offset.
   * @param {boolean} toEnd True when the bytes go to the end of the file.
   * @returns {Promise<ReadableStream<Uint8Array>>}
   */
  retrieve(path, offset, length, toEnd) {
    return new Promise((resolve, reject) => {
      this.#run(async () => {
        const data = await this.#openData();
        // REST comes just before RETR: some servers forget it after EPSV.
        if (offset > 0) {
          const reply = await this.#send(`REST ${offset}`).catch((error) => {
            data.close();
            throw error;
          });
          if (reply.code !== 350) {
            data.close();
            throw new FTPError(reply.code, message(reply));
          }
        }
        const reply = await this.#send(`RETR ${path}`);
        if (reply.code !== 125 && reply.code !== 150) {
          data.close();
          throw new FTPError(reply.code, message(reply));
        }
        let left = length;
        let finished = false;
        /** @type {(value?: unknown) => void} */
        let ended = () => {};
        const end = new Promise((done) => ended = done);
        /** @param {boolean} complete */
        const finish = async (complete) => {
          if (finished) return;
          finished = true;
          data.close();
          if (complete) {
            const last = await this.#endReply(this.#options.closeTimeout)
              .catch(() => null);
            if (!last || last.code >= 400) this.broken = true;
          } else {
            this.broken = true;
          }
          ended();
        };
        // The end of the file: the end of the data connection, or the
        // answer at the end of the transfer, which comes after the last
        // byte. Deno 2.9 loses the end of a TLS connection that ends while
        // the socket is paused.
        const finishAtEnd = async () => {
          if (finished) return;
          finished = true;
          const last = this.#endReply(this.#options.closeTimeout)
            .catch(() => null);
          const drained = (async () => {
            try {
              while (await data.read() !== null) {
                // A file that grows: the bytes after its size go.
              }
            } catch {
              // The data connection closes below.
            }
          })();
          await Promise.race([drained, last]);
          data.close();
          const reply = await last;
          if (!reply || reply.code >= 400) this.broken = true;
          ended();
        };
        resolve(
          new ReadableStream({
            async pull(controller) {
              try {
                if (left > 0) {
                  const chunk = await data.read();
                  if (chunk === null) {
                    await finish(true);
                    if (left === Infinity) controller.close();
                    else {
                      controller.error(
                        new Error("The file is shorter than its size"),
                      );
                    }
                    return;
                  }
                  const part = chunk.length > left
                    ? chunk.subarray(0, left)
                    : chunk;
                  left -= part.length;
                  controller.enqueue(part);
                  if (left > 0) return;
                }
                // All the bytes of the range are read.
                await (toEnd ? finishAtEnd() : finish(false));
                controller.close();
              } catch (error) {
                await finish(false);
                controller.error(error);
              }
            },
            async cancel() {
              await finish(false);
            },
          }),
        );
        await end;
      }).catch(reject);
    });
  }

  /**
   * Gives the time of a file with MDTM.
   * @param {string} path
   * @returns {Promise<string>} The time in ISO 8601, or "".
   */
  async modTime(path) {
    if (!this.canGetTime) return "";
    const reply = await this.command(`MDTM ${path}`);
    return parseTime((reply.lines.at(-1) ?? "").slice(4).trim());
  }

  /**
   * Sets the time of a file, to the second, with MFMT, or with MDTM as
   * vsftpd.
   * @param {string} path
   * @param {Date} time In the years 1000 to 9999.
   */
  async setModTime(path, time) {
    const text = time.toISOString().replace(/\.\d+Z$/, "").replace(/\D/g, "");
    const command = this.features.has("MFMT") ? "MFMT" : "MDTM";
    await this.command(`${command} ${text} ${path}`);
  }

  /**
   * Gives the size of a file with SIZE.
   * @param {string} path
   * @returns {Promise<number>} -1 when the server does not give it.
   */
  async size(path) {
    if (!this.features.has("SIZE")) return -1;
    const reply = await this.command(`SIZE ${path}`);
    const size = Number((reply.lines.at(-1) ?? "").slice(4).trim());
    return Number.isSafeInteger(size) && size >= 0 ? size : -1;
  }

  /**
   * The entry of a path, with MLST.
   * @param {string} path
   * @returns {Promise<import("./list.js").Item | null>} null for a path
   *   that does not exist.
   */
  async stat(path) {
    try {
      const reply = await this.command(`MLST ${path}`);
      for (const line of reply.lines.slice(1, -1)) {
        const item = parseMLSD(line.replace(/^ /, "").replace(/ .*$/, " x"));
        if (item) return { ...item, name: path };
      }
      return null;
    } catch (error) {
      // 550 and 450: no such file. 501: a name that the server does not
      // take, as rclone.
      if (
        error instanceof FTPError && (error.code >= 500 || error.code === 450)
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * The entries of a folder, with MLSD, or with LIST.
   * @param {string} path
   * @returns {Promise<import("./list.js").Item[]>}
   */
  async list(path) {
    const mlsd = this.mlsd;
    const verb = mlsd
      ? "MLSD"
      : this.#options.forceListHidden
      ? "LIST -a"
      : "LIST";
    // No path is the current folder: the login folder.
    const command = path === "" ? verb : `${verb} ${path}`;
    const text = await this.transfer(command, async (data) => {
      /** @type {Uint8Array[]} */
      const chunks = [];
      for (let chunk = await data.read(); chunk; chunk = await data.read()) {
        chunks.push(chunk);
      }
      return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
    }, false);
    /** @type {import("./list.js").Item[]} */
    const items = [];
    for (const line of text.split(/\r?\n/)) {
      if (line === "") continue;
      const item = mlsd ? parseMLSD(line) : parseLIST(line);
      if (item) items.push(item);
    }
    return items;
  }

  /**
   * Uploads a file with STOR.
   * @param {string} path
   * @param {ReadableStream<Uint8Array>} body
   * @returns {Promise<number>} The number of bytes.
   */
  async store(path, body) {
    let size = 0;
    await this.transfer(`STOR ${path}`, async (data) => {
      for await (const chunk of body) {
        size += chunk.length;
        await data.write(chunk);
      }
      // The end of the writes is the end of the file.
      await data.end();
    });
    return size;
  }

  /**
   * Tells if the connection keeps the process of Node.js running.
   * @param {boolean} active
   */
  setActive(active) {
    this.#control.setActive(active);
  }

  /** Closes the connection, with QUIT. */
  async close() {
    if (!this.broken) {
      await Promise.race([
        this.#run(() => this.#send("QUIT")).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    this.#control.close();
  }
}

/**
 * Makes sure that an answer has a code, else throws its error.
 * @param {Reply} reply
 * @param {number} code
 */
function expect(reply, code) {
  if (reply.code !== code) throw new FTPError(reply.code, message(reply));
}

/**
 * The text of an answer.
 * @param {Reply} reply
 */
function message(reply) {
  return reply.lines.map((line) => line.replace(/^\d{3}[ -]/, "")).join(" ")
    .trim();
}
