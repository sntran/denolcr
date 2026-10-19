/**
 * The transport layer of SSH, as RFC 4253: the exchange of the versions,
 * the exchange of the keys, and the packets with their encryption.
 *
 * The key exchanges: `curve25519-sha256` (RFC 8731) and
 * `ecdh-sha2-nistp256`, `ecdh-sha2-nistp384` and `ecdh-sha2-nistp521`
 * (RFC 5656), with the strict key exchange of OpenSSH against the Terrapin
 * attack. The server can exchange new keys at any time.
 */

import { CIPHERS, MACS, makeCipher, noCipher } from "./cipher.js";
import { fingerprint, readPublicKey } from "./keys.js";
import { concat, ProtocolError, Reader, Writer } from "./wire.js";

const { subtle } = globalThis.crypto;

/** The numbers of the messages of SSH. */
export const MSG = {
  DISCONNECT: 1,
  IGNORE: 2,
  UNIMPLEMENTED: 3,
  DEBUG: 4,
  SERVICE_REQUEST: 5,
  SERVICE_ACCEPT: 6,
  EXT_INFO: 7,
  KEXINIT: 20,
  NEWKEYS: 21,
  KEX_ECDH_INIT: 30,
  KEX_ECDH_REPLY: 31,
};

/** The version of the client. */
const VERSION = "SSH-2.0-rfetch";

/** The key exchanges, by preference, with their hashes and curves. */
export const KEX = {
  "curve25519-sha256": { hash: "SHA-256", curve: "X25519", bits: 256 },
  "curve25519-sha256@libssh.org": {
    hash: "SHA-256",
    curve: "X25519",
    bits: 256,
  },
  "ecdh-sha2-nistp256": { hash: "SHA-256", curve: "P-256", bits: 256 },
  "ecdh-sha2-nistp384": { hash: "SHA-384", curve: "P-384", bits: 384 },
  "ecdh-sha2-nistp521": { hash: "SHA-512", curve: "P-521", bits: 528 },
};

/** The algorithms of the host keys, by preference. */
export const HOST_KEYS = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-512",
  "rsa-sha2-256",
];

/** The type of the key of each algorithm of a host key. */
const KEY_TYPES = {
  "rsa-sha2-512": "ssh-rsa",
  "rsa-sha2-256": "ssh-rsa",
};

/**
 * The host key of a server, for the check of the client.
 * @typedef {Object} HostKey
 * @property {string} type For example `ssh-ed25519`.
 * @property {Uint8Array} blob The key in the format of SSH.
 * @property {string} fingerprint For example `SHA256:...`.
 */

/**
 * The options of a transport.
 * @typedef {Object} TransportOptions
 * @property {(key: HostKey) => boolean | Promise<boolean>} checkHostKey
 *   Tells if the client accepts the host key of the server.
 * @property {string[]} [hostKeyTypes] The types of the keys that the client
 *   knows for the server: the client asks for them first.
 * @property {string[]} [ciphers] The ciphers, by preference.
 * @property {string[]} [macs] The MACs, by preference.
 * @property {string[]} [kex] The key exchanges, by preference.
 * @property {string[]} [hostKeyAlgorithms] The algorithms of the host keys,
 *   by preference.
 */

/** An error of the server, with its message `SSH_MSG_DISCONNECT`. */
export class DisconnectError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message || `The server closed the connection (code ${code})`);
    this.code = code;
  }
}

/** The transport layer of a client of SSH. */
export class Transport {
  /** @type {import("./socket.js").Connection} */
  #socket;
  /** @type {TransportOptions} */
  #options;
  #clientVersion = VERSION;
  #serverVersion = "";
  /** @type {Uint8Array | null} */
  sessionId = null;
  /** The algorithms of the signatures of the server, from `EXT_INFO`. */
  /** @type {string[] | null} */
  serverSigAlgs = null;

  #out = { cipher: noCipher(), sequence: 0 };
  #in = { cipher: noCipher(), sequence: 0 };
  #strict = false;
  #firstKex = true;
  /** The writes of the packets, in the order of their sequence numbers. */
  /** @type {Promise<void>} */
  #writes = Promise.resolve();
  /** A key exchange that runs, or null. */
  /** @type {Promise<void> | null} */
  #kex = null;
  /** @type {(() => void) | null} */
  #kexDone = null;
  /** Our KEXINIT of the key exchange that runs. */
  /** @type {Uint8Array | null} */
  #ourKexInit = null;
  /** True when the next packet of the server is a wrong guess to ignore. */
  #skipGuess = false;

  /**
   * @param {import("./socket.js").Connection} socket
   * @param {TransportOptions} options
   */
  constructor(socket, options) {
    this.#socket = socket;
    this.#options = options;
  }

  /**
   * Exchanges the versions and the first keys.
   * @returns {Promise<void>}
   */
  async start() {
    await this.#socket.write(
      new TextEncoder().encode(`${this.#clientVersion}\r\n`),
    );
    // A server can send other lines before its version.
    for (let lines = 0;; lines++) {
      if (lines > 50) throw new ProtocolError("The server sent no version");
      const line = new TextDecoder().decode(await this.#socket.readLine(255));
      if (!line.startsWith("SSH-")) continue;
      if (!/^SSH-(2\.0|1\.99)-/.test(line)) {
        throw new ProtocolError(`The server version ${line} is not SSH 2`);
      }
      this.#serverVersion = line;
      break;
    }
    this.#beginKex();
    const payload = await this.#readPacket();
    if (payload[0] !== MSG.KEXINIT) {
      throw new ProtocolError("The server did not start the key exchange");
    }
    await this.#exchange(payload);
  }

  /** Starts a key exchange: the writes of other messages wait. */
  #beginKex() {
    if (this.#kex) return;
    this.#kex = new Promise((resolve) => this.#kexDone = resolve);
    this.#ourKexInit = this.#kexInit();
    this.#post(this.#ourKexInit);
  }

  /**
   * Writes a packet of the key exchange, with no wait. An error of the
   * write comes again from the next read.
   * @param {Uint8Array} payload
   * @param {() => void} [after]
   */
  #post(payload, after) {
    this.#writePacket(payload, after).catch(() => {});
  }

  /** Our message KEXINIT. */
  #kexInit() {
    const { hostKeyTypes = [] } = this.#options;
    // The algorithms of the known keys come first, as OpenSSH does.
    const algorithms = this.#options.hostKeyAlgorithms ?? HOST_KEYS;
    const known = algorithms.filter((name) =>
      hostKeyTypes.includes(KEY_TYPES[name] ?? name)
    );
    const hostKeys = [
      ...known,
      ...algorithms.filter((name) => !known.includes(name)),
    ];
    const kex = [...(this.#options.kex ?? Object.keys(KEX))];
    if (this.#firstKex) kex.push("ext-info-c", "kex-strict-c-v00@openssh.com");
    const ciphers = this.#options.ciphers ?? Object.keys(CIPHERS);
    const macs = this.#options.macs ?? Object.keys(MACS);
    return new Writer()
      .byte(MSG.KEXINIT)
      .raw(crypto.getRandomValues(new Uint8Array(16)))
      .nameList(kex)
      .nameList(hostKeys)
      .nameList(ciphers)
      .nameList(ciphers)
      .nameList(macs)
      .nameList(macs)
      .nameList(["none"])
      .nameList(["none"])
      .nameList([])
      .nameList([])
      .boolean(false)
      .uint32(0)
      .bytes();
  }

  /**
   * Runs a key exchange, from the KEXINIT of the server.
   * @param {Uint8Array} serverKexInit
   */
  async #exchange(serverKexInit) {
    this.#beginKex();
    const ours = new Reader(/** @type {Uint8Array} */ (this.#ourKexInit));
    const theirs = new Reader(serverKexInit);
    ours.raw(17);
    theirs.raw(17);
    /** @type {string[][]} */
    const client = [];
    /** @type {string[][]} */
    const server = [];
    for (let i = 0; i < 10; i++) {
      client.push(ours.nameList());
      server.push(theirs.nameList());
    }
    const guess = theirs.boolean();
    if (this.#firstKex) {
      this.#strict = server[0].includes("kex-strict-s-v00@openssh.com");
    }
    /** @param {number} i @param {string} what */
    const choose = (i, what) => {
      const found = client[i].find((name) =>
        server[i].includes(name) && !name.startsWith("ext-info-") &&
        !name.startsWith("kex-strict-")
      );
      if (!found) {
        throw new ProtocolError(
          `No ${what} in common with the server: ${server[i].join(",")}`,
        );
      }
      return found;
    };
    const kexName = choose(0, "key exchange");
    const hostKeyName = choose(1, "host key algorithm");
    const cipherOut = choose(2, "cipher");
    const cipherIn = choose(3, "cipher");
    const macOut = CIPHERS[cipherOut].gcm ? null : choose(4, "MAC");
    const macIn = CIPHERS[cipherIn].gcm ? null : choose(5, "MAC");
    choose(6, "compression");
    choose(7, "compression");
    // A wrong guess of the server: its next packet is for another exchange.
    if (guess && (server[0][0] !== kexName || server[1][0] !== hostKeyName)) {
      this.#skipGuess = true;
    }

    const kex = KEX[kexName];
    const params = kex.curve === "X25519"
      ? { name: "X25519" }
      : { name: "ECDH", namedCurve: kex.curve };
    const pair = /** @type {CryptoKeyPair} */ (
      await subtle.generateKey(params, true, ["deriveBits"])
    );
    const clientPublic = new Uint8Array(
      await subtle.exportKey("raw", pair.publicKey),
    );
    this.#post(
      new Writer().byte(MSG.KEX_ECDH_INIT).string(clientPublic).bytes(),
    );

    const reply = new Reader(await this.#readKexPacket(MSG.KEX_ECDH_REPLY));
    reply.byte();
    const hostKeyBlob = reply.bytes();
    const serverPublic = reply.bytes();
    const signature = reply.bytes();

    let peer;
    try {
      peer = await subtle.importKey("raw", serverPublic, params, false, []);
    } catch {
      throw new ProtocolError("The public key of the server is not correct");
    }
    const secret = new Uint8Array(
      await subtle.deriveBits(
        { ...params, public: peer },
        pair.privateKey,
        kex.bits,
      ),
    );
    if (secret.every((byte) => byte === 0)) {
      throw new ProtocolError("The shared secret is zero");
    }
    const k = new Writer().mpint(secret).bytes();
    const exchange = new Writer()
      .string(this.#clientVersion)
      .string(this.#serverVersion)
      .string(/** @type {Uint8Array} */ (this.#ourKexInit))
      .string(serverKexInit)
      .string(hostKeyBlob)
      .string(clientPublic)
      .string(serverPublic)
      .raw(k)
      .bytes();
    const h = new Uint8Array(await subtle.digest(kex.hash, exchange));

    // The host key: its type, the choice of the client, and its signature.
    const hostKey = await readPublicKey(hostKeyBlob);
    if (hostKey.type !== (KEY_TYPES[hostKeyName] ?? hostKeyName)) {
      throw new ProtocolError(
        `The host key ${hostKey.type} is not of the algorithm ${hostKeyName}`,
      );
    }
    if (!await hostKey.verify(hostKeyName, signature, h)) {
      throw new ProtocolError("The signature of the host key is not correct");
    }
    const accepted = await this.#options.checkHostKey({
      type: hostKey.type,
      blob: hostKeyBlob,
      fingerprint: await fingerprint(hostKeyBlob),
    });
    if (!accepted) {
      throw new ProtocolError(
        `The host key ${await fingerprint(hostKeyBlob)} is not known`,
      );
    }

    this.sessionId ??= h;
    /**
     * The key of a letter, as RFC 4253 section 7.2.
     * @param {string} letter
     * @param {number} size
     */
    const derive = async (letter, size) => {
      let key = new Uint8Array(
        await subtle.digest(
          kex.hash,
          concat(
            k,
            h,
            new TextEncoder().encode(letter),
            /** @type {Uint8Array} */ (this.sessionId),
          ),
        ),
      );
      while (key.length < size) {
        key = concat(
          key,
          new Uint8Array(await subtle.digest(kex.hash, concat(k, h, key))),
        );
      }
      return key.subarray(0, size);
    };
    /** @param {string} cipher @param {string | null} mac @param {string[]} letters */
    const keysOf = async (cipher, mac, [iv, key, integrity]) => ({
      iv: await derive(iv, CIPHERS[cipher].iv),
      key: await derive(key, CIPHERS[cipher].key),
      mac: mac ? await derive(integrity, MACS[mac].key) : new Uint8Array(0),
    });
    const out = await makeCipher(
      cipherOut,
      macOut,
      await keysOf(cipherOut, macOut, ["A", "C", "E"]),
    );
    const input = await makeCipher(
      cipherIn,
      macIn,
      await keysOf(cipherIn, macIn, ["B", "D", "F"]),
    );

    // NEWKEYS, then the new keys for the next packets.
    this.#post(new Uint8Array([MSG.NEWKEYS]), () => {
      this.#out.cipher = out;
      if (this.#strict) this.#out.sequence = 0;
    });
    await this.#readKexPacket(MSG.NEWKEYS);
    this.#in.cipher = input;
    if (this.#strict) this.#in.sequence = 0;

    this.#firstKex = false;
    this.#ourKexInit = null;
    const done = this.#kexDone;
    this.#kex = null;
    this.#kexDone = null;
    done?.();
  }

  /**
   * Reads a packet of a key exchange.
   * @param {number} type The number of the message.
   */
  async #readKexPacket(type) {
    while (true) {
      const payload = await this.#readPacket();
      if (this.#skipGuess) {
        this.#skipGuess = false;
        continue;
      }
      if (payload[0] === type) return payload;
      if (payload[0] === MSG.DISCONNECT) throw disconnectError(payload);
      // The strict key exchange allows no other message.
      if (
        !this.#strict &&
        (payload[0] === MSG.IGNORE || payload[0] === MSG.DEBUG)
      ) continue;
      throw new ProtocolError(
        `The message ${payload[0]} came in the key exchange`,
      );
    }
  }

  /**
   * Writes a packet, after the packets before it.
   * @param {Uint8Array} payload
   * @param {() => void} [after] Runs after the write of the packet, before
   *   the next packet.
   * @returns {Promise<void>}
   */
  #writePacket(payload, after) {
    const write = this.#writes.then(async () => {
      const { cipher } = this.#out;
      const block = Math.max(8, cipher.blockSize);
      const counted = cipher.lengthInClear ? 1 : 5;
      let padding = block - ((counted + payload.length) % block);
      if (padding < 4) padding += block;
      const packet = new Uint8Array(1 + payload.length + padding);
      packet[0] = padding;
      packet.set(payload, 1);
      crypto.getRandomValues(packet.subarray(1 + payload.length));
      const sequence = this.#out.sequence;
      this.#out.sequence = (sequence + 1) >>> 0;
      const bytes = await cipher.seal(sequence, packet);
      after?.();
      await this.#socket.write(bytes);
    });
    // A failed write fails the writes after it too.
    this.#writes = write;
    return write;
  }

  /**
   * Reads the payload of a packet.
   * @returns {Promise<Uint8Array>}
   */
  async #readPacket() {
    const sequence = this.#in.sequence;
    this.#in.sequence = (sequence + 1) >>> 0;
    const packet = await this.#in.cipher.open(sequence, this.#socket);
    const padding = packet[0];
    if (padding < 4 || padding + 1 > packet.length) {
      throw new ProtocolError("The padding of a packet is not correct");
    }
    if (packet.length - 1 - padding < 1) {
      throw new ProtocolError("A packet has no message");
    }
    return packet.subarray(1, packet.length - padding);
  }

  /**
   * Sends a message. It waits for the end of a key exchange.
   * @param {Uint8Array} payload
   * @returns {Promise<void>}
   */
  async send(payload) {
    while (this.#kex) await this.#kex;
    return await this.#writePacket(payload);
  }

  /**
   * Receives the next message of the layers over the transport: the
   * transport answers the key exchanges and drops IGNORE and DEBUG.
   * @returns {Promise<Uint8Array>}
   * @throws {DisconnectError} When the server closes the connection.
   */
  async receive() {
    while (true) {
      const payload = await this.#readPacket();
      switch (payload[0]) {
        case MSG.DISCONNECT:
          throw disconnectError(payload);
        case MSG.IGNORE:
        case MSG.DEBUG:
        case MSG.UNIMPLEMENTED:
          continue;
        case MSG.EXT_INFO:
          this.#readExtInfo(payload);
          continue;
        case MSG.KEXINIT:
          await this.#exchange(payload);
          continue;
        default:
          if (payload[0] >= 20 && payload[0] <= 49) {
            throw new ProtocolError(
              `The message ${payload[0]} came out of a key exchange`,
            );
          }
          return payload;
      }
    }
  }

  /** @param {Uint8Array} payload */
  #readExtInfo(payload) {
    const reader = new Reader(payload);
    reader.byte();
    const count = reader.uint32();
    for (let i = 0; i < count; i++) {
      const name = reader.string();
      const value = reader.bytes();
      if (name === "server-sig-algs") {
        this.serverSigAlgs = new TextDecoder().decode(value).split(",");
      }
    }
  }

  /**
   * Tells if the connection keeps the process of Node.js running.
   * @param {boolean} active
   */
  setActive(active) {
    this.#socket.setActive(active);
  }

  /**
   * Sends DISCONNECT, and closes the connection.
   * @param {string} [reason]
   */
  async close(reason = "") {
    try {
      await Promise.race([
        this.#writePacket(
          new Writer()
            .byte(MSG.DISCONNECT)
            .uint32(11)
            .string(reason)
            .string("")
            .bytes(),
        ),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    } catch {
      // The connection is closed.
    }
    this.#socket.close();
  }
}

/**
 * The error of a message DISCONNECT.
 * @param {Uint8Array} payload
 */
function disconnectError(payload) {
  const reader = new Reader(payload);
  reader.byte();
  const code = reader.uint32();
  let message = "";
  try {
    message = reader.string();
  } catch {
    // A message that is not UTF-8.
  }
  return new DisconnectError(code, message);
}
