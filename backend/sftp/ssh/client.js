/**
 * A client of SSH: the authentication of the user, as RFC 4252, and the
 * channels of the connection, as RFC 4254.
 */

import { Connection } from "./socket.js";
import { DisconnectError, Transport } from "./transport.js";
import { ProtocolError, Reader, Writer } from "./wire.js";

/** The numbers of the messages of the authentication and the channels. */
const MSG = {
  SERVICE_REQUEST: 5,
  SERVICE_ACCEPT: 6,
  USERAUTH_REQUEST: 50,
  USERAUTH_FAILURE: 51,
  USERAUTH_SUCCESS: 52,
  USERAUTH_BANNER: 53,
  USERAUTH_INFO_REQUEST: 60,
  USERAUTH_INFO_RESPONSE: 61,
  GLOBAL_REQUEST: 80,
  REQUEST_SUCCESS: 81,
  REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90,
  CHANNEL_OPEN_CONFIRMATION: 91,
  CHANNEL_OPEN_FAILURE: 92,
  CHANNEL_WINDOW_ADJUST: 93,
  CHANNEL_DATA: 94,
  CHANNEL_EXTENDED_DATA: 95,
  CHANNEL_EOF: 96,
  CHANNEL_CLOSE: 97,
  CHANNEL_REQUEST: 98,
  CHANNEL_SUCCESS: 99,
  CHANNEL_FAILURE: 100,
};

/** The window of a channel: the bytes that the server can send. */
const WINDOW = 2 * 1024 * 1024;

/**
 * The largest data of one message of the server on a channel: a packet of
 * SFTP with 32 KiB of data fits in one message.
 */
const MAX_DATA = 64 * 1024;

/** The largest data of one message of the client, as OpenSSH. */
const MAX_SEND = 32 * 1024;

/** An error of the authentication of the user. */
export class AuthenticationError extends Error {}

/**
 * The options of a connection.
 * @typedef {Object} ClientOptions
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {string} [password]
 * @property {import("./keys.js").PrivateKey} [privateKey]
 * @property {(key: import("./transport.js").HostKey) => boolean | Promise<boolean>} checkHostKey
 * @property {string[]} [hostKeyTypes] The types of the keys that the
 *   client knows for the server.
 * @property {{ ciphers?: string[], macs?: string[], kex?: string[], hostKeyAlgorithms?: string[] }} [algorithms]
 *   The algorithms that the client can use, by preference.
 * @property {number} [timeout] The time to connect, in milliseconds.
 */

/** A connection of SSH, with the user signed in. */
export class SSHClient {
  /** @type {Transport} */
  #transport;
  /** @type {Map<number, Channel>} */
  #channels = new Map();
  #nextId = 0;
  /** @type {Error | null} */
  #error = null;
  /** @type {Promise<void>} */
  closed;

  /** @param {Transport} transport */
  constructor(transport) {
    this.#transport = transport;
    this.closed = this.#readLoop();
  }

  /**
   * Opens a connection, and signs in the user.
   * @param {ClientOptions} options
   * @returns {Promise<SSHClient>}
   * @throws {AuthenticationError | ProtocolError | Error}
   */
  static async connect(options) {
    const socket = await Connection.open(
      options.host,
      options.port,
      options.timeout ?? 60000,
    );
    const transport = new Transport(socket, {
      checkHostKey: options.checkHostKey,
      hostKeyTypes: options.hostKeyTypes,
      ...options.algorithms,
    });
    try {
      await transport.start();
      await authenticate(transport, options);
    } catch (error) {
      await transport.close();
      throw error;
    }
    return new SSHClient(transport);
  }

  /** Reads the messages of the server, and gives them to the channels. */
  async #readLoop() {
    try {
      while (true) {
        const payload = await this.#transport.receive();
        this.#dispatch(payload);
      }
    } catch (error) {
      this.#error = error instanceof Error ? error : new Error(String(error));
      for (const channel of this.#channels.values()) channel.fail(this.#error);
      this.#channels.clear();
    }
  }

  /** @param {Uint8Array} payload */
  #dispatch(payload) {
    const reader = new Reader(payload);
    const type = reader.byte();
    if (type === MSG.GLOBAL_REQUEST) {
      reader.string();
      if (reader.boolean()) {
        this.#send(new Uint8Array([MSG.REQUEST_FAILURE]));
      }
      return;
    }
    if (type < MSG.CHANNEL_OPEN || type > MSG.CHANNEL_FAILURE) {
      // An unexpected message, for example of the authentication.
      return;
    }
    const channel = this.#channels.get(reader.uint32());
    if (!channel) {
      throw new ProtocolError("A message came for a channel that is closed");
    }
    channel.receive(type, reader);
    if (channel.isClosed) this.#channels.delete(channel.id);
  }

  /**
   * Sends a message. An error of the write ends the connection.
   * @param {Uint8Array} payload
   */
  #send(payload) {
    return this.#transport.send(payload);
  }

  /**
   * Opens a channel of a session.
   * @returns {Promise<Channel>}
   */
  async openSession() {
    if (this.#error) throw this.#error;
    const id = this.#nextId++;
    const channel = new Channel(id, (payload) => this.#send(payload));
    this.#channels.set(id, channel);
    await this.#send(
      new Writer()
        .byte(MSG.CHANNEL_OPEN)
        .string("session")
        .uint32(id)
        .uint32(WINDOW)
        .uint32(MAX_DATA)
        .bytes(),
    );
    await channel.opened;
    return channel;
  }

  /**
   * Opens a channel with a subsystem, for example `sftp`.
   * @param {string} name
   * @returns {Promise<Channel>}
   */
  async subsystem(name) {
    const channel = await this.openSession();
    const ok = await channel.request(
      "subsystem",
      true,
      (writer) => writer.string(name),
    );
    if (!ok) {
      await channel.close();
      throw new ProtocolError(`The server has no subsystem ${name}`);
    }
    return channel;
  }

  /** True when the connection cannot send more. */
  get isClosed() {
    return this.#error !== null;
  }

  /**
   * Tells if the connection keeps the process of Node.js running.
   * @param {boolean} active
   */
  setActive(active) {
    this.#transport.setActive(active);
  }

  /** Closes the connection. */
  async close() {
    await this.#transport.close();
    await this.closed;
  }
}

/**
 * Signs in the user: with the key, then with the password, then with
 * keyboard-interactive and the password, as rclone.
 * @param {Transport} transport
 * @param {ClientOptions} options
 */
async function authenticate(transport, options) {
  await transport.send(
    new Writer().byte(MSG.SERVICE_REQUEST).string("ssh-userauth").bytes(),
  );
  const accept = await transport.receive();
  if (accept[0] !== MSG.SERVICE_ACCEPT) {
    throw new ProtocolError("The server did not accept the authentication");
  }
  const { username, password, privateKey } = options;
  /** @param {string} method */
  const request = (method) =>
    new Writer()
      .byte(MSG.USERAUTH_REQUEST)
      .string(username)
      .string("ssh-connection")
      .string(method);

  /**
   * Reads the answer of a request of authentication.
   * @returns {Promise<{ ok: boolean, methods: string[] }>}
   */
  const answer = async () => {
    while (true) {
      const payload = await transport.receive();
      const reader = new Reader(payload);
      const type = reader.byte();
      if (type === MSG.USERAUTH_SUCCESS) return { ok: true, methods: [] };
      if (type === MSG.USERAUTH_FAILURE) {
        return { ok: false, methods: reader.nameList() };
      }
      if (type === MSG.USERAUTH_BANNER) continue;
      if (type === MSG.USERAUTH_INFO_REQUEST) {
        // The answer of each prompt of keyboard-interactive is the password.
        reader.string();
        reader.string();
        reader.string();
        const count = reader.uint32();
        const writer = new Writer().byte(MSG.USERAUTH_INFO_RESPONSE).uint32(
          count,
        );
        for (let i = 0; i < count; i++) writer.string(password ?? "");
        await transport.send(writer.bytes());
        continue;
      }
      throw new ProtocolError(`The message ${type} came in the authentication`);
    }
  };

  await transport.send(request("none").bytes());
  let { ok, methods } = await answer();
  if (ok) return;

  if (privateKey && methods.includes("publickey")) {
    for (const algorithm of signatureAlgorithms(privateKey, transport)) {
      const signed = request("publickey")
        .boolean(true)
        .string(algorithm)
        .string(privateKey.blob)
        .bytes();
      const data = new Writer()
        .string(/** @type {Uint8Array} */ (transport.sessionId))
        .raw(signed)
        .bytes();
      await transport.send(
        new Writer()
          .raw(signed)
          .string(await privateKey.sign(algorithm, data))
          .bytes(),
      );
      ({ ok, methods } = await answer());
      if (ok) return;
      if (!methods.includes("publickey")) break;
    }
  }
  if (password !== undefined && methods.includes("password")) {
    await transport.send(
      request("password").boolean(false).string(password).bytes(),
    );
    ({ ok, methods } = await answer());
    if (ok) return;
  }
  if (password !== undefined && methods.includes("keyboard-interactive")) {
    await transport.send(
      request("keyboard-interactive").string("").string("").bytes(),
    );
    ({ ok, methods } = await answer());
    if (ok) return;
  }
  throw new AuthenticationError(
    `The server refused the user ${username}: it accepts ${
      methods.join(", ") || "no method"
    }`,
  );
}

/**
 * The algorithms of the signatures of a key, that the server accepts.
 * @param {import("./keys.js").PrivateKey} key
 * @param {Transport} transport
 */
function signatureAlgorithms(key, transport) {
  if (key.type !== "ssh-rsa") return key.algorithms;
  const accepted = transport.serverSigAlgs;
  if (accepted) {
    const found = key.algorithms.find((name) => accepted.includes(name));
    return found ? [found] : [];
  }
  // A server with no list of its algorithms can be old.
  return ["rsa-sha2-256", "ssh-rsa"];
}

/** A channel of a connection. */
export class Channel {
  /** @type {number} */
  id;
  /** The number of the channel for the server. */
  remoteId = -1;
  #remoteWindow = 0;
  #remoteMax = MAX_SEND;
  #localWindow = WINDOW;
  /** The bytes that the client read, and did not give to the window. */
  #consumed = 0;
  /** @type {(payload: Uint8Array) => Promise<void>} */
  #send;
  /** @type {Uint8Array[]} */
  #data = [];
  /** The data of the standard error, for `exec`. */
  /** @type {Uint8Array[]} */
  stderr = [];
  /** @type {number | null} */
  exitStatus = null;
  #eof = false;
  isClosed = false;
  #sentClose = false;
  /** @type {Error | null} */
  #error = null;
  /** @type {(() => void) | null} */
  #wakeRead = null;
  /** @type {(() => void) | null} */
  #wakeWrite = null;
  /** The writes of the channel, in their order. */
  /** @type {Promise<void>} */
  #writes = Promise.resolve();
  /** @type {((ok: boolean) => void)[]} */
  #replies = [];
  /** @type {Promise<void>} */
  opened;
  /** @type {(() => void) | null} */
  #resolveOpen = null;
  /** @type {((error: Error) => void) | null} */
  #rejectOpen = null;
  /** @type {Promise<void>} */
  closedPromise;
  /** @type {(() => void) | null} */
  #resolveClosed = null;

  /**
   * @param {number} id
   * @param {(payload: Uint8Array) => Promise<void>} send
   */
  constructor(id, send) {
    this.id = id;
    this.#send = send;
    this.opened = new Promise((resolve, reject) => {
      this.#resolveOpen = resolve;
      this.#rejectOpen = reject;
    });
    this.opened.catch(() => {});
    this.closedPromise = new Promise((resolve) =>
      this.#resolveClosed = resolve
    );
  }

  /**
   * Takes a message of the server for this channel.
   * @param {number} type
   * @param {Reader} reader
   */
  receive(type, reader) {
    switch (type) {
      case MSG.CHANNEL_OPEN_CONFIRMATION:
        this.remoteId = reader.uint32();
        this.#remoteWindow = reader.uint32();
        this.#remoteMax = Math.min(reader.uint32(), MAX_SEND);
        this.#resolveOpen?.();
        break;
      case MSG.CHANNEL_OPEN_FAILURE: {
        reader.uint32();
        const message = reader.string();
        this.isClosed = true;
        this.#rejectOpen?.(
          new ProtocolError(`The server refused a channel: ${message}`),
        );
        this.#resolveClosed?.();
        break;
      }
      case MSG.CHANNEL_WINDOW_ADJUST:
        this.#remoteWindow = Math.min(
          this.#remoteWindow + reader.uint32(),
          0xffffffff,
        );
        this.#wake("write");
        break;
      case MSG.CHANNEL_DATA:
      case MSG.CHANNEL_EXTENDED_DATA: {
        const extended = type === MSG.CHANNEL_EXTENDED_DATA
          ? reader.uint32()
          : null;
        const data = reader.bytes();
        if (data.length > this.#localWindow) {
          throw new ProtocolError("The server sent more than the window");
        }
        this.#localWindow -= data.length;
        if (extended === null) {
          this.#data.push(data);
          this.#wake("read");
        } else {
          this.stderr.push(data);
          this.#consume(data.length);
        }
        break;
      }
      case MSG.CHANNEL_EOF:
        this.#eof = true;
        this.#wake("read");
        break;
      case MSG.CHANNEL_CLOSE:
        this.#eof = true;
        this.isClosed = true;
        if (!this.#sentClose) {
          this.#sentClose = true;
          this.#send(
            new Writer().byte(MSG.CHANNEL_CLOSE).uint32(this.remoteId).bytes(),
          ).catch(() => {});
        }
        for (const reply of this.#replies.splice(0)) reply(false);
        this.#wake("read");
        this.#wake("write");
        this.#resolveClosed?.();
        break;
      case MSG.CHANNEL_REQUEST: {
        const name = reader.string();
        const wantReply = reader.boolean();
        if (name === "exit-status") this.exitStatus = reader.uint32();
        if (wantReply) {
          this.#send(
            new Writer().byte(MSG.CHANNEL_FAILURE).uint32(this.remoteId)
              .bytes(),
          ).catch(() => {});
        }
        break;
      }
      case MSG.CHANNEL_SUCCESS:
      case MSG.CHANNEL_FAILURE:
        this.#replies.shift()?.(type === MSG.CHANNEL_SUCCESS);
        break;
    }
  }

  /** @param {"read" | "write"} side */
  #wake(side) {
    if (side === "read") {
      const wake = this.#wakeRead;
      this.#wakeRead = null;
      wake?.();
    } else {
      const wake = this.#wakeWrite;
      this.#wakeWrite = null;
      wake?.();
    }
  }

  /**
   * Ends the channel with an error of the connection.
   * @param {Error} error
   */
  fail(error) {
    this.#error = error;
    this.isClosed = true;
    this.#rejectOpen?.(error);
    for (const reply of this.#replies.splice(0)) reply(false);
    this.#wake("read");
    this.#wake("write");
    this.#resolveClosed?.();
  }

  /**
   * Gives the read bytes back to the window of the server.
   * @param {number} size
   */
  #consume(size) {
    this.#consumed += size;
    if (this.#consumed >= WINDOW / 2 && !this.isClosed) {
      const add = this.#consumed;
      this.#consumed = 0;
      this.#localWindow += add;
      this.#send(
        new Writer()
          .byte(MSG.CHANNEL_WINDOW_ADJUST)
          .uint32(this.remoteId)
          .uint32(add)
          .bytes(),
      ).catch(() => {});
    }
  }

  /**
   * Sends a request of the channel.
   * @param {string} name For example `subsystem` or `exec`.
   * @param {boolean} wantReply
   * @param {(writer: Writer) => void} [write] Writes the data of the request.
   * @returns {Promise<boolean>} True when the server accepts the request.
   */
  async request(name, wantReply, write) {
    const writer = new Writer()
      .byte(MSG.CHANNEL_REQUEST)
      .uint32(this.remoteId)
      .string(name)
      .boolean(wantReply);
    write?.(writer);
    const reply = wantReply
      ? new Promise((resolve) => this.#replies.push(resolve))
      : Promise.resolve(true);
    await this.#send(writer.bytes());
    return await reply;
  }

  /**
   * Reads the next bytes of the channel.
   * @returns {Promise<Uint8Array | null>} null at the end of the data.
   */
  async read() {
    while (this.#data.length === 0) {
      if (this.#error) throw this.#error;
      if (this.#eof) return null;
      await new Promise((resolve) => this.#wakeRead = resolve);
    }
    const data = /** @type {Uint8Array} */ (this.#data.shift());
    this.#consume(data.length);
    return data;
  }

  /**
   * Writes bytes to the channel, in the window of the server. The writes
   * go one after the other: the bytes of two writes do not mix.
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   */
  write(bytes) {
    const write = this.#writes.then(() => this.#write(bytes));
    this.#writes = write.catch(() => {});
    return write;
  }

  /** @param {Uint8Array} bytes */
  async #write(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.#error) throw this.#error;
      if (this.isClosed) throw new ProtocolError("The channel is closed");
      if (this.#remoteWindow === 0) {
        await new Promise((resolve) => this.#wakeWrite = resolve);
        continue;
      }
      const size = Math.min(
        bytes.length - offset,
        this.#remoteWindow,
        this.#remoteMax,
      );
      this.#remoteWindow -= size;
      await this.#send(
        new Writer(size + 9)
          .byte(MSG.CHANNEL_DATA)
          .uint32(this.remoteId)
          .string(bytes.subarray(offset, offset + size))
          .bytes(),
      );
      offset += size;
    }
  }

  /** Sends the end of the data of the client. */
  async eof() {
    if (this.isClosed) return;
    await this.#send(
      new Writer().byte(MSG.CHANNEL_EOF).uint32(this.remoteId).bytes(),
    );
  }

  /** Closes the channel, and waits for the close of the server. */
  async close() {
    if (!this.isClosed && !this.#sentClose) {
      this.#sentClose = true;
      await this.#send(
        new Writer().byte(MSG.CHANNEL_CLOSE).uint32(this.remoteId).bytes(),
      ).catch(() => {});
    }
    await this.closedPromise;
  }
}

export { DisconnectError };
