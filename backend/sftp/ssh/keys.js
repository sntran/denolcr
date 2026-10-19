/**
 * The keys of SSH: the host keys of a server, and the private keys of a
 * user, with WebCrypto.
 *
 * The algorithms: `ssh-ed25519`, `ecdsa-sha2-nistp256`,
 * `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521`, and RSA with
 * `rsa-sha2-512`, `rsa-sha2-256` and `ssh-rsa`, as RFC 8709, RFC 5656 and
 * RFC 8332.
 */

import { isOID, oid, readDER, readOne, TAG, writeDER } from "./der.js";
import { concat, mpintBytes, ProtocolError, Reader, Writer } from "./wire.js";

const { subtle } = globalThis.crypto;

/** The curves of ECDSA, by their names in SSH. */
const CURVES = {
  nistp256: {
    name: "P-256",
    hash: "SHA-256",
    size: 32,
    oid: "1.2.840.10045.3.1.7",
  },
  nistp384: { name: "P-384", hash: "SHA-384", size: 48, oid: "1.3.132.0.34" },
  nistp521: { name: "P-521", hash: "SHA-512", size: 66, oid: "1.3.132.0.35" },
};

/** The hashes of the signatures of RSA, by their names in SSH. */
const RSA_HASHES = {
  "rsa-sha2-512": "SHA-512",
  "rsa-sha2-256": "SHA-256",
  "ssh-rsa": "SHA-1",
};

/** The smallest size of an RSA key, in bits, as OpenSSH. */
const MIN_RSA_BITS = 1024;

/**
 * Encodes bytes in base64url, for JWK.
 * @param {Uint8Array} bytes
 */
function base64url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes base64url, of JWK.
 * @param {string} text
 */
function fromBase64url(text) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * Decodes base64.
 * @param {string} text
 * @throws {ProtocolError} For text that is not base64.
 */
export function fromBase64(text) {
  try {
    return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  } catch {
    throw new ProtocolError("The text is not base64");
  }
}

/**
 * Encodes bytes in base64.
 * @param {Uint8Array} bytes
 */
export function toBase64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/**
 * The bytes of a number with no 0 byte before it, with a size.
 * @param {Uint8Array} bytes A number that is not negative, big-endian.
 * @param {number} size
 */
function fixed(bytes, size) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  bytes = bytes.subarray(start);
  if (bytes.length > size) throw new ProtocolError("A number is too large");
  const result = new Uint8Array(size);
  result.set(bytes, size - bytes.length);
  return result;
}

/**
 * A public key of SSH.
 * @typedef {Object} PublicKey
 * @property {string} type For example `ssh-ed25519` or `ssh-rsa`.
 * @property {Uint8Array} blob The key in the format of SSH.
 * @property {(algorithm: string, signature: Uint8Array, data: Uint8Array) => Promise<boolean>} verify
 *   Checks a signature in the format of SSH.
 */

/**
 * Reads a public key in the format of SSH, as the host key of a server.
 * @param {Uint8Array} blob
 * @returns {Promise<PublicKey>}
 * @throws {ProtocolError} For a key that rfetch does not know.
 */
export async function readPublicKey(blob) {
  const reader = new Reader(blob);
  const type = reader.string();
  if (type === "ssh-ed25519") {
    const raw = reader.bytes();
    if (raw.length !== 32) throw new ProtocolError("An Ed25519 key is wrong");
    const key = await subtle.importKey("raw", raw, "Ed25519", true, ["verify"]);
    return {
      type,
      blob,
      verify: async (algorithm, signature, data) => {
        const sig = readSignature(signature, algorithm);
        if (algorithm !== type || sig.length !== 64) return false;
        return await subtle.verify("Ed25519", key, sig, data);
      },
    };
  }
  if (type.startsWith("ecdsa-sha2-")) {
    const name = reader.string();
    const curve = CURVES[name];
    if (!curve || type !== `ecdsa-sha2-${name}`) {
      throw new ProtocolError(`The curve of ${type} is not known`);
    }
    const key = await subtle.importKey(
      "raw",
      reader.bytes(),
      { name: "ECDSA", namedCurve: curve.name },
      true,
      ["verify"],
    );
    return {
      type,
      blob,
      verify: async (algorithm, signature, data) => {
        if (algorithm !== type) return false;
        const numbers = new Reader(readSignature(signature, algorithm));
        let raw;
        try {
          raw = concat(
            fixed(numbers.bytes(), curve.size),
            fixed(numbers.bytes(), curve.size),
          );
        } catch {
          return false;
        }
        return await subtle.verify(
          { name: "ECDSA", hash: curve.hash },
          key,
          raw,
          data,
        );
      },
    };
  }
  if (type === "ssh-rsa") {
    const e = reader.bytes();
    const n = reader.bytes();
    const bits = bitLength(n);
    if (bits < MIN_RSA_BITS) {
      throw new ProtocolError(`An RSA key of ${bits} bits is too small`);
    }
    const jwk = {
      kty: "RSA",
      n: base64url(fixed(n, Math.ceil(bits / 8))),
      e: base64url(fixed(e, e.length)),
    };
    /** @type {Map<string, CryptoKey>} */
    const keys = new Map();
    return {
      type,
      blob,
      verify: async (algorithm, signature, data) => {
        const hash = RSA_HASHES[algorithm];
        if (!hash) return false;
        let key = keys.get(hash);
        if (!key) {
          key = await subtle.importKey(
            "jwk",
            jwk,
            { name: "RSASSA-PKCS1-v1_5", hash },
            false,
            ["verify"],
          );
          keys.set(hash, key);
        }
        return await subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          readSignature(signature, algorithm),
          data,
        );
      },
    };
  }
  throw new ProtocolError(`The key type ${type} is not known`);
}

/**
 * The bytes of a signature in the format of SSH.
 * @param {Uint8Array} signature `string algorithm, string bytes`.
 * @param {string} algorithm The algorithm that the signature must have.
 * @returns {Uint8Array} No bytes for another algorithm.
 */
function readSignature(signature, algorithm) {
  const reader = new Reader(signature);
  if (reader.string() !== algorithm) return new Uint8Array(0);
  const bytes = reader.bytes();
  return reader.remaining === 0 ? bytes : new Uint8Array(0);
}

/**
 * The number of bits of a number.
 * @param {Uint8Array} bytes Big-endian.
 */
function bitLength(bytes) {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start++;
  if (start === bytes.length) return 0;
  return (bytes.length - start - 1) * 8 + (32 - Math.clz32(bytes[start]));
}

/**
 * The fingerprint of a public key, as OpenSSH: `SHA256:` and the hash in
 * base64 with no `=`.
 * @param {Uint8Array} blob
 */
export async function fingerprint(blob) {
  const hash = new Uint8Array(await subtle.digest("SHA-256", blob));
  return `SHA256:${toBase64(hash).replace(/=+$/, "")}`;
}

/**
 * A private key of a user.
 * @typedef {Object} PrivateKey
 * @property {string} type For example `ssh-ed25519`.
 * @property {Uint8Array} blob The public key in the format of SSH.
 * @property {(algorithm: string, data: Uint8Array) => Promise<Uint8Array>} sign
 *   Signs data, and gives the signature in the format of SSH.
 * @property {string[]} algorithms The algorithms of the signatures, in the
 *   order of preference.
 */

/**
 * Reads a private key of a PEM file: OpenSSH (`BEGIN OPENSSH PRIVATE KEY`),
 * PKCS #8 (`BEGIN PRIVATE KEY`), PKCS #1 (`BEGIN RSA PRIVATE KEY`) or SEC 1
 * (`BEGIN EC PRIVATE KEY`). The key must not have a passphrase.
 * @param {string} pem
 * @returns {Promise<PrivateKey>}
 * @throws {ProtocolError} For a key that rfetch cannot read.
 */
export async function readPrivateKey(pem) {
  const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(
    pem,
  );
  if (!match) throw new ProtocolError("The key is not a PEM file");
  const [, label, body] = match;
  if (/Proc-Type:\s*4,ENCRYPTED/.test(body)) {
    throw new ProtocolError("rfetch cannot read a key with a passphrase");
  }
  const der = fromBase64(body.replace(/^[\w-]+:.*$/gm, "").replace(/\s/g, ""));
  if (label === "OPENSSH PRIVATE KEY") return await readOpenSSHKey(der);
  if (label === "PRIVATE KEY") return await readPKCS8(der);
  if (label === "RSA PRIVATE KEY") return await rsaKey(readPKCS1(der));
  if (label === "EC PRIVATE KEY") return await readSEC1(der);
  if (label === "ENCRYPTED PRIVATE KEY") {
    throw new ProtocolError("rfetch cannot read a key with a passphrase");
  }
  throw new ProtocolError(`rfetch cannot read a key of the type ${label}`);
}

/**
 * Reads a key of the format `openssh-key-v1` of OpenSSH.
 * @param {Uint8Array} bytes
 */
async function readOpenSSHKey(bytes) {
  const magic = new TextEncoder().encode("openssh-key-v1\0");
  if (!magic.every((byte, i) => bytes[i] === byte)) {
    throw new ProtocolError("The key is not an OpenSSH key");
  }
  const reader = new Reader(bytes.subarray(magic.length));
  const cipher = reader.string();
  const kdf = reader.string();
  reader.bytes();
  if (cipher !== "none" || kdf !== "none") {
    throw new ProtocolError("rfetch cannot read a key with a passphrase");
  }
  if (reader.uint32() !== 1) {
    throw new ProtocolError("The file must have one key");
  }
  reader.bytes();
  const keys = new Reader(reader.bytes());
  if (keys.uint32() !== keys.uint32()) {
    throw new ProtocolError("The key is not correct");
  }
  const type = keys.string();
  if (type === "ssh-ed25519") {
    const pub = keys.bytes();
    const secret = keys.bytes();
    if (pub.length !== 32 || secret.length !== 64) {
      throw new ProtocolError("The Ed25519 key is not correct");
    }
    return await ed25519Key({
      kty: "OKP",
      crv: "Ed25519",
      d: base64url(secret.subarray(0, 32)),
      x: base64url(pub),
    });
  }
  if (type.startsWith("ecdsa-sha2-")) {
    const curve = CURVES[keys.string()];
    if (!curve) throw new ProtocolError(`The curve of ${type} is not known`);
    const point = keys.bytes();
    const d = keys.mpint();
    return await ecdsaKey(curve, pointJWK(curve, point, d));
  }
  if (type === "ssh-rsa") {
    const n = keys.mpint();
    const e = keys.mpint();
    const d = keys.mpint();
    const qi = keys.mpint();
    const p = keys.mpint();
    const q = keys.mpint();
    return await rsaKey({ n, e, d, p, q, qi });
  }
  throw new ProtocolError(`The key type ${type} is not known`);
}

/**
 * The JWK of a private key of ECDSA, from its point and its number.
 * @param {typeof CURVES.nistp256} curve
 * @param {Uint8Array} point The public point, not compressed.
 * @param {bigint} d
 */
function pointJWK(curve, point, d) {
  if (point.length !== 1 + 2 * curve.size || point[0] !== 4) {
    throw new ProtocolError("The point of the key is not correct");
  }
  return {
    kty: "EC",
    crv: curve.name,
    x: base64url(point.subarray(1, 1 + curve.size)),
    y: base64url(point.subarray(1 + curve.size)),
    d: base64url(fixed(mpintBytes(d), curve.size)),
  };
}

/**
 * Reads a key of PKCS #8, of RSA, ECDSA or Ed25519.
 * @param {Uint8Array} bytes
 */
async function readPKCS8(bytes) {
  const [version, algorithm, key] = readDER(readOne(bytes, TAG.SEQUENCE));
  if (
    version?.tag !== TAG.INTEGER || algorithm?.tag !== TAG.SEQUENCE ||
    key?.tag !== TAG.OCTET_STRING
  ) {
    throw new ProtocolError("The PKCS #8 key is not correct");
  }
  const [id, parameter] = readDER(algorithm.value);
  if (isOID(id.value, "1.3.101.112")) {
    const seed = readOne(key.value, TAG.OCTET_STRING);
    const imported = await subtle.importKey("pkcs8", bytes, "Ed25519", true, [
      "sign",
    ]);
    const jwk = await subtle.exportKey("jwk", imported);
    if (seed.length !== 32 || !jwk.x) {
      throw new ProtocolError("The Ed25519 key is not correct");
    }
    return await ed25519Key(jwk);
  }
  if (isOID(id.value, "1.2.840.10045.2.1")) {
    const curve = Object.values(CURVES).find((curve) =>
      isOID(parameter?.value ?? new Uint8Array(0), curve.oid)
    );
    if (!curve) throw new ProtocolError("The curve of the key is not known");
    const imported = await subtle.importKey(
      "pkcs8",
      bytes,
      { name: "ECDSA", namedCurve: curve.name },
      true,
      ["sign"],
    );
    return await ecdsaKey(curve, await subtle.exportKey("jwk", imported));
  }
  if (isOID(id.value, "1.2.840.113549.1.1.1")) {
    // The OCTET STRING of the key has the key of PKCS #1.
    return await rsaKey(readPKCS1(key.value));
  }
  throw new ProtocolError("The algorithm of the key is not known");
}

/**
 * Reads the numbers of a key of PKCS #1.
 * @param {Uint8Array} bytes
 */
function readPKCS1(bytes) {
  const numbers = readDER(readOne(bytes, TAG.SEQUENCE)).map((element) => {
    if (element.tag !== TAG.INTEGER) {
      throw new ProtocolError("The RSA key is not correct");
    }
    let value = 0n;
    for (const byte of element.value) value = (value << 8n) | BigInt(byte);
    return value;
  });
  if (numbers.length < 9) throw new ProtocolError("The RSA key is too short");
  const [, n, e, d, p, q, , , qi] = numbers;
  return { n, e, d, p, q, qi };
}

/**
 * Reads a key of SEC 1, of ECDSA.
 * @param {Uint8Array} bytes
 */
async function readSEC1(bytes) {
  const elements = readDER(readOne(bytes, TAG.SEQUENCE));
  const secret = elements[1];
  const parameters = elements.find((element) => element.tag === 0xa0);
  const publicKey = elements.find((element) => element.tag === 0xa1);
  const id = parameters ? readOne(parameters.value, TAG.OID) : null;
  const curve = Object.values(CURVES).find((curve) =>
    id && isOID(id, curve.oid)
  );
  if (!curve || secret?.tag !== TAG.OCTET_STRING) {
    throw new ProtocolError("The EC key is not correct");
  }
  let d = 0n;
  for (const byte of secret.value) d = (d << 8n) | BigInt(byte);
  if (publicKey) {
    // The BIT STRING has a first byte with the number of bits that are not
    // used.
    const point = readOne(publicKey.value, TAG.BIT_STRING).subarray(1);
    return await ecdsaKey(curve, pointJWK(curve, point, d));
  }
  // With no public point, PKCS #8 gives the key to WebCrypto, which finds
  // the point.
  const pkcs8 = writeDER(
    TAG.SEQUENCE,
    writeDER(TAG.INTEGER, new Uint8Array([0])),
    writeDER(TAG.SEQUENCE, oid("1.2.840.10045.2.1"), oid(curve.oid)),
    writeDER(
      TAG.OCTET_STRING,
      writeDER(
        TAG.SEQUENCE,
        writeDER(TAG.INTEGER, new Uint8Array([1])),
        writeDER(TAG.OCTET_STRING, secret.value),
      ),
    ),
  );
  return await readPKCS8(pkcs8);
}

/**
 * A private key of Ed25519.
 * @param {JsonWebKey} jwk
 * @returns {Promise<PrivateKey>}
 */
async function ed25519Key(jwk) {
  const key = await subtle.importKey("jwk", jwk, "Ed25519", false, ["sign"]);
  const type = "ssh-ed25519";
  return {
    type,
    blob: new Writer().string(type).string(fromBase64url(jwk.x ?? "")).bytes(),
    algorithms: [type],
    sign: async (_algorithm, data) =>
      new Writer()
        .string(type)
        .string(new Uint8Array(await subtle.sign("Ed25519", key, data)))
        .bytes(),
  };
}

/**
 * A private key of ECDSA.
 * @param {typeof CURVES.nistp256} curve
 * @param {JsonWebKey} jwk
 * @returns {Promise<PrivateKey>}
 */
async function ecdsaKey(curve, jwk) {
  const key = await subtle.importKey(
    "jwk",
    { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    { name: "ECDSA", namedCurve: curve.name },
    false,
    ["sign"],
  );
  const name = Object.keys(CURVES).find((name) => CURVES[name] === curve);
  const type = `ecdsa-sha2-${name}`;
  const point = concat(
    new Uint8Array([4]),
    fromBase64url(jwk.x ?? ""),
    fromBase64url(jwk.y ?? ""),
  );
  return {
    type,
    blob: new Writer().string(type).string(name ?? "").string(point).bytes(),
    algorithms: [type],
    sign: async (_algorithm, data) => {
      const raw = new Uint8Array(
        await subtle.sign({ name: "ECDSA", hash: curve.hash }, key, data),
      );
      const numbers = new Writer()
        .mpint(raw.subarray(0, curve.size))
        .mpint(raw.subarray(curve.size))
        .bytes();
      return new Writer().string(type).string(numbers).bytes();
    },
  };
}

/**
 * A private key of RSA.
 * @param {{ n: bigint, e: bigint, d: bigint, p: bigint, q: bigint, qi: bigint }} numbers
 * @returns {Promise<PrivateKey>}
 */
async function rsaKey({ n, e, d, p, q, qi }) {
  const bytes = (value) =>
    mpintBytes(value).subarray(
      mpintBytes(value)[0] === 0 ? 1 : 0,
    );
  const bits = bitLength(bytes(n));
  if (bits < MIN_RSA_BITS) {
    throw new ProtocolError(`An RSA key of ${bits} bits is too small`);
  }
  const jwk = {
    kty: "RSA",
    n: base64url(bytes(n)),
    e: base64url(bytes(e)),
    d: base64url(bytes(d)),
    p: base64url(bytes(p)),
    q: base64url(bytes(q)),
    dp: base64url(bytes(d % (p - 1n))),
    dq: base64url(bytes(d % (q - 1n))),
    qi: base64url(bytes(qi)),
  };
  /** @type {Map<string, CryptoKey>} */
  const keys = new Map();
  const type = "ssh-rsa";
  return {
    type,
    blob: new Writer().string(type).mpint(e).mpint(n).bytes(),
    algorithms: ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
    sign: async (algorithm, data) => {
      const hash = RSA_HASHES[algorithm];
      if (!hash) throw new ProtocolError(`${algorithm} is not an RSA hash`);
      let key = keys.get(hash);
      if (!key) {
        key = await subtle.importKey(
          "jwk",
          jwk,
          { name: "RSASSA-PKCS1-v1_5", hash },
          false,
          ["sign"],
        );
        keys.set(hash, key);
      }
      const signature = new Uint8Array(
        await subtle.sign("RSASSA-PKCS1-v1_5", key, data),
      );
      return new Writer().string(algorithm).string(signature).bytes();
    },
  };
}

/**
 * Reads a line of `authorized_keys` or of the option `host_keys`: the type
 * of the key and the key in base64.
 * @param {string} line For example `ssh-ed25519 AAAAC3Nza...`.
 * @returns {{ type: string, blob: Uint8Array }}
 * @throws {ProtocolError} For a line that is not correct.
 */
export function readKeyLine(line) {
  const [type, text] = line.trim().split(/\s+/);
  if (!type || !text) throw new ProtocolError("The key line is not correct");
  const blob = fromBase64(text);
  if (new Reader(blob).string() !== type) {
    throw new ProtocolError("The type of the key is not its type in base64");
  }
  return { type, blob };
}
