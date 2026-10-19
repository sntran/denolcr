/**
 * The ciphers and the MACs of the packets of SSH, with WebCrypto, as
 * RFC 4253 section 6, RFC 4344 (AES-CTR), RFC 5647 and the
 * `aes*-gcm@openssh.com` of OpenSSH (AES-GCM), and the `*-etm@openssh.com`
 * MACs of OpenSSH.
 */

import { concat, ProtocolError } from "./wire.js";

const { subtle } = globalThis.crypto;

/** The largest packet that the client reads, as OpenSSH. */
export const MAX_PACKET = 256 * 1024;

/** The ciphers, with the sizes of their keys and of their IVs. */
export const CIPHERS = {
  "aes128-gcm@openssh.com": { key: 16, iv: 12, gcm: true },
  "aes256-gcm@openssh.com": { key: 32, iv: 12, gcm: true },
  "aes128-ctr": { key: 16, iv: 16, gcm: false },
  "aes192-ctr": { key: 24, iv: 16, gcm: false },
  "aes256-ctr": { key: 32, iv: 16, gcm: false },
};

/** The MACs, with the sizes of their keys. */
export const MACS = {
  "hmac-sha2-256-etm@openssh.com": { key: 32, hash: "SHA-256", etm: true },
  "hmac-sha2-512-etm@openssh.com": { key: 64, hash: "SHA-512", etm: true },
  "hmac-sha2-256": { key: 32, hash: "SHA-256", etm: false },
  "hmac-sha2-512": { key: 64, hash: "SHA-512", etm: false },
};

/**
 * The reads of the bytes of a connection.
 * @typedef {{ read(size: number): Promise<Uint8Array> }} Source
 */

/**
 * Seals and opens the packets of one direction.
 * @typedef {Object} PacketCipher
 * @property {number} blockSize
 * @property {boolean} lengthInClear True when the length of a packet is not
 *   encrypted: then the padding does not count the length.
 * @property {(sequence: number, packet: Uint8Array) => Promise<Uint8Array>} seal
 *   Makes the bytes of a packet from `padding_length || payload || padding`.
 * @property {(sequence: number, source: Source) => Promise<Uint8Array>} open
 *   Reads a packet, and gives `padding_length || payload || padding`.
 */

/**
 * The length of a packet, as 4 bytes.
 * @param {number} length
 */
function lengthBytes(length) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, length);
  return bytes;
}

/**
 * Reads the length of a packet, and checks it.
 * @param {Uint8Array} bytes
 * @param {number} blockSize The length must be a multiple of it.
 */
function readLength(bytes, blockSize) {
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  if (length < 5 || length > MAX_PACKET || length % blockSize !== 0) {
    throw new ProtocolError(`The length ${length} of a packet is not correct`);
  }
  return length;
}

/**
 * The cipher of the start of a connection: no encryption, and no MAC.
 * @returns {PacketCipher}
 */
export function noCipher() {
  return {
    blockSize: 8,
    lengthInClear: false,
    seal: async (_sequence, packet) =>
      concat(lengthBytes(packet.length), packet),
    open: async (_sequence, source) => {
      const header = await source.read(4);
      const view = new DataView(header.buffer, header.byteOffset, 4);
      const length = view.getUint32(0);
      if (length < 5 || length > MAX_PACKET) {
        throw new ProtocolError(`The length ${length} of a packet is wrong`);
      }
      return await source.read(length);
    },
  };
}

/**
 * The cipher of one direction, with its keys.
 * @param {string} name The name of the cipher.
 * @param {string | null} macName The name of the MAC, or null for AES-GCM.
 * @param {{ key: Uint8Array, iv: Uint8Array, mac: Uint8Array }} keys
 * @returns {Promise<PacketCipher>}
 */
export async function makeCipher(name, macName, keys) {
  const spec = CIPHERS[name];
  if (!spec) throw new ProtocolError(`The cipher ${name} is not known`);
  if (spec.gcm) return await gcmCipher(keys.key, keys.iv);
  const mac = MACS[macName ?? ""];
  if (!mac) throw new ProtocolError(`The MAC ${macName} is not known`);
  return await ctrCipher(keys.key, keys.iv, mac, keys.mac);
}

/**
 * AES-GCM, as RFC 5647: the length is not encrypted, and it is the
 * additional data. The IV has a fixed part of 4 bytes and a counter of 8
 * bytes, which goes up by one for each packet.
 * @param {Uint8Array} keyBytes
 * @param {Uint8Array} ivBytes
 * @returns {Promise<PacketCipher>}
 */
async function gcmCipher(keyBytes, ivBytes) {
  const key = await subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  const iv = ivBytes.slice();
  const view = new DataView(iv.buffer);
  const next = () => {
    view.setBigUint64(4, (view.getBigUint64(4) + 1n) & 0xffffffffffffffffn);
  };
  return {
    blockSize: 16,
    lengthInClear: true,
    seal: async (_sequence, packet) => {
      const length = lengthBytes(packet.length);
      const sealed = new Uint8Array(
        await subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: length, tagLength: 128 },
          key,
          packet,
        ),
      );
      next();
      return concat(length, sealed);
    },
    open: async (_sequence, source) => {
      const header = await source.read(4);
      const length = readLength(header, 16);
      const sealed = await source.read(length + 16);
      let packet;
      try {
        packet = await subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: header, tagLength: 128 },
          key,
          sealed,
        );
      } catch {
        throw new ProtocolError("The MAC of a packet is not correct");
      }
      next();
      return new Uint8Array(packet);
    },
  };
}

/**
 * Adds a number of blocks to the counter of AES-CTR, a number of 128 bits.
 * @param {Uint8Array} counter
 * @param {number} blocks
 */
function addBlocks(counter, blocks) {
  let carry = blocks;
  for (let i = 15; i >= 0 && carry > 0; i--) {
    const sum = counter[i] + (carry % 256);
    counter[i] = sum & 0xff;
    carry = Math.floor(carry / 256) + (sum >> 8);
  }
}

/**
 * AES-CTR with an HMAC, as RFC 4344, or with the MAC of the encrypted
 * packet (`*-etm@openssh.com`).
 * @param {Uint8Array} keyBytes
 * @param {Uint8Array} ivBytes
 * @param {typeof MACS[keyof typeof MACS]} mac
 * @param {Uint8Array} macBytes
 * @returns {Promise<PacketCipher>}
 */
async function ctrCipher(keyBytes, ivBytes, mac, macBytes) {
  const key = await subtle.importKey("raw", keyBytes, "AES-CTR", false, [
    "encrypt",
    "decrypt",
  ]);
  const macKey = await subtle.importKey(
    "raw",
    macBytes.subarray(0, mac.key),
    { name: "HMAC", hash: mac.hash },
    false,
    ["sign", "verify"],
  );
  const macSize = mac.key;
  const counter = ivBytes.slice(0, 16);
  /**
   * Encrypts or decrypts bytes from the counter, and moves the counter.
   * @param {Uint8Array} bytes A multiple of 16 bytes.
   */
  const crypt = async (bytes) => {
    const result = new Uint8Array(
      await subtle.encrypt(
        { name: "AES-CTR", counter, length: 128 },
        key,
        bytes,
      ),
    );
    addBlocks(counter, bytes.length / 16);
    return result;
  };
  /** @param {number} sequence @param {Uint8Array[]} parts */
  const sign = async (sequence, ...parts) =>
    new Uint8Array(
      await subtle.sign(
        "HMAC",
        macKey,
        concat(lengthBytes(sequence), ...parts),
      ),
    );
  /**
   * @param {number} sequence
   * @param {Uint8Array} tag
   * @param {Uint8Array[]} parts
   */
  const verify = async (sequence, tag, ...parts) => {
    const ok = await subtle.verify(
      "HMAC",
      macKey,
      tag,
      concat(lengthBytes(sequence), ...parts),
    );
    if (!ok) throw new ProtocolError("The MAC of a packet is not correct");
  };

  if (mac.etm) {
    return {
      blockSize: 16,
      lengthInClear: true,
      seal: async (sequence, packet) => {
        const length = lengthBytes(packet.length);
        const encrypted = await crypt(packet);
        return concat(
          length,
          encrypted,
          await sign(sequence, length, encrypted),
        );
      },
      open: async (sequence, source) => {
        const header = await source.read(4);
        const length = readLength(header, 16);
        const encrypted = await source.read(length);
        // The MAC is checked before the decryption.
        await verify(sequence, await source.read(macSize), header, encrypted);
        return await crypt(encrypted);
      },
    };
  }
  return {
    blockSize: 16,
    lengthInClear: false,
    seal: async (sequence, packet) => {
      const plain = concat(lengthBytes(packet.length), packet);
      const tag = await sign(sequence, plain);
      return concat(await crypt(plain), tag);
    },
    open: async (sequence, source) => {
      const first = await crypt(await source.read(16));
      const length = readLength(first, 1);
      if ((length + 4) % 16 !== 0) {
        throw new ProtocolError("The length of a packet is not correct");
      }
      const rest = await crypt(await source.read(length + 4 - 16));
      const plain = concat(first, rest);
      await verify(sequence, await source.read(macSize), plain);
      return plain.subarray(4);
    },
  };
}
