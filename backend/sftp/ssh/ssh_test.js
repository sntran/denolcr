/**
 * The tests of the parts of the client of SSH that need no server: the data
 * types, the ciphers, the keys and the file `known_hosts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { CIPHERS, MACS, makeCipher } from "./cipher.js";
import { findHostKey } from "../knownhosts.js";
import {
  fingerprint,
  readKeyLine,
  readPrivateKey,
  readPublicKey,
  toBase64,
} from "./keys.js";
import { mpintBytes, Reader, Writer } from "./wire.js";
import { KEY_PARAMS, makeKeys } from "../testing.js";

test("Writer and Reader keep each type of SSH", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 255 }),
      fc.boolean(),
      fc.integer({ min: 0, max: 0xffffffff }),
      fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
      fc.string(),
      fc.bigInt({ min: 0n, max: 2n ** 600n }),
      fc.array(fc.stringMatching(/^[a-z0-9@.-]+$/)),
      (byte, boolean, uint32, uint64, string, mpint, names) => {
        const reader = new Reader(
          new Writer()
            .byte(byte)
            .boolean(boolean)
            .uint32(uint32)
            .uint64(uint64)
            .string(string)
            .mpint(mpint)
            .nameList(names)
            .bytes(),
        );
        assert.equal(reader.byte(), byte);
        assert.equal(reader.boolean(), boolean);
        assert.equal(reader.uint32(), uint32);
        assert.equal(reader.uint64(), uint64);
        assert.equal(reader.string(), string);
        assert.equal(reader.mpint(), mpint);
        assert.deepEqual(reader.nameList(), names.length ? names : []);
        assert.equal(reader.remaining, 0);
      },
    ),
  );
});

test("mpint is as the examples of RFC 4251", () => {
  /** @param {bigint} value */
  const hex = (value) => Buffer.from(mpintBytes(value)).toString("hex");
  assert.equal(hex(0n), "");
  assert.equal(hex(0x9a378f9b2e332a7n), "09a378f9b2e332a7");
  assert.equal(hex(0x80n), "0080");
});

test("each cipher opens the packets that it seals", async () => {
  for (const name of Object.keys(CIPHERS)) {
    for (const mac of CIPHERS[name].gcm ? [null] : Object.keys(MACS)) {
      const keys = {
        key: crypto.getRandomValues(new Uint8Array(CIPHERS[name].key)),
        iv: crypto.getRandomValues(new Uint8Array(CIPHERS[name].iv)),
        mac: crypto.getRandomValues(new Uint8Array(64)),
      };
      const out = await makeCipher(name, mac, keys);
      const input = await makeCipher(name, mac, keys);
      /** @type {Uint8Array[]} */
      const wire = [];
      /** @type {Uint8Array[]} */
      const packets = [];
      for (let sequence = 0; sequence < 5; sequence++) {
        const size = 16 * (1 + sequence * 7) - (out.lengthInClear ? 0 : 4);
        const packet = crypto.getRandomValues(new Uint8Array(size));
        packet[0] = 4;
        packets.push(packet);
        wire.push(await out.seal(sequence, packet));
      }
      // The bytes come in one stream.
      const stream = Buffer.concat(wire);
      let offset = 0;
      const source = {
        /** @param {number} size */
        read: async (size) => {
          const bytes = stream.subarray(offset, offset + size);
          offset += size;
          return new Uint8Array(bytes);
        },
      };
      for (let sequence = 0; sequence < 5; sequence++) {
        assert.deepEqual(
          await input.open(sequence, source),
          packets[sequence],
          `${name} ${mac}`,
        );
      }
      // A changed byte fails the MAC.
      const broken = new Uint8Array(wire[0]);
      broken[broken.length - 1] ^= 1;
      const other = await makeCipher(name, mac, keys);
      await assert.rejects(
        other.open(0, { read: async (size) => broken.subarray(0, size) }),
        /MAC|length/,
      );
    }
  }
});

test("readPrivateKey reads PKCS #8 and OpenSSH, and signs", async () => {
  for (const [name, params] of Object.entries(KEY_PARAMS)) {
    const { key, openssh } = await makeKeys(params);
    const other = await readPrivateKey(openssh);
    assert.equal(other.type, key.type, name);
    assert.deepEqual(other.blob, key.blob, name);
    const publicKey = await readPublicKey(key.blob);
    const data = crypto.getRandomValues(new Uint8Array(100));
    for (const algorithm of key.algorithms.slice(0, 2)) {
      for (const signer of [key, other]) {
        const signature = await signer.sign(algorithm, data);
        assert.ok(
          await publicKey.verify(algorithm, signature, data),
          `${name} ${algorithm}`,
        );
        assert.ok(
          !await publicKey.verify(algorithm, signature, data.subarray(1)),
          `${name} ${algorithm} with other data`,
        );
      }
    }
  }
});

test("readPrivateKey refuses a key with a passphrase", async () => {
  await assert.rejects(
    readPrivateKey(
      "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nAAAA\n-----END RSA PRIVATE KEY-----",
    ),
    /passphrase/,
  );
  const encrypted = new Writer()
    .raw(new TextEncoder().encode("openssh-key-v1\0"))
    .string("aes256-ctr")
    .string("bcrypt")
    .string("")
    .bytes();
  await assert.rejects(
    readPrivateKey(
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${
        toBase64(encrypted)
      }\n-----END OPENSSH PRIVATE KEY-----`,
    ),
    /passphrase/,
  );
});

test("fingerprint is the SHA256 fingerprint of OpenSSH", async () => {
  // The key of RFC 8709 is not here: the fingerprint of OpenSSH is the
  // SHA-256 of the key in base64 with no padding.
  const blob = new Writer().string("ssh-ed25519").string(new Uint8Array(32))
    .bytes();
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", blob));
  assert.equal(
    await fingerprint(blob),
    `SHA256:${digest.toString("base64").replace(/=+$/, "")}`,
  );
  assert.deepEqual(readKeyLine(`ssh-ed25519 ${toBase64(blob)} comment`), {
    type: "ssh-ed25519",
    blob,
  });
  assert.throws(() => readKeyLine(`ssh-rsa ${toBase64(blob)}`), /type/);
});

test("findHostKey reads the lines of known_hosts", async () => {
  const blob = new Writer().string("ssh-ed25519").string(new Uint8Array(32))
    .bytes();
  const other = new Writer().string("ssh-ed25519").string(
    new Uint8Array(32).fill(1),
  ).bytes();
  const line = `ssh-ed25519 ${toBase64(blob)}`;
  const otherLine = `ssh-ed25519 ${toBase64(other)}`;
  for (
    const [text, host, port, expected] of [
      [`example.com ${line}`, "example.com", 22, "known"],
      [`EXAMPLE.com ${line}`, "example.com", 22, "known"],
      [`a.com,example.com ${line}`, "example.com", 22, "known"],
      [`*.com ${line}`, "example.com", 22, "known"],
      [`*.com,!example.com ${line}`, "example.com", 22, "unknown"],
      [`exampl?.com ${line}`, "example.com", 22, "known"],
      [`example.com ${line}`, "example.com", 2222, "unknown"],
      [`[example.com]:2222 ${line}`, "example.com", 2222, "known"],
      [`example.com ${otherLine}`, "example.com", 22, "changed"],
      [
        `example.com ${otherLine}\nexample.com ${line}`,
        "example.com",
        22,
        "known",
      ],
      [`@revoked * ${line}\nexample.com ${line}`, "example.com", 22, "revoked"],
      [`@cert-authority *.com ${line}`, "example.com", 22, "unknown"],
      [`# example.com ${line}\n\n`, "example.com", 22, "unknown"],
      [`example.com ssh-ed25519 !!!`, "example.com", 22, "unknown"],
    ]
  ) {
    assert.equal(
      await findHostKey(text, host, port, blob),
      expected,
      `${text} for ${host}:${port}`,
    );
  }
});
