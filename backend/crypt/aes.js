import * as nodeCrypto from "node:crypto";

const BLOCK_SIZE = 16;
const ROUNDS = 14;

/**
 * AES-256 in ECB mode with no padding, the block cipher of EME. Each call
 * takes one or more blocks of 16 bytes.
 *
 * It uses AES-256-ECB of `node:crypto`. One object does all the calls of one
 * direction, because ECB keeps no state between blocks. A runtime with no AES
 * in `node:crypto` gets `aes256js`: in a build of Cloudflare Pages,
 * `createCipheriv` is a stub of unenv that throws.
 * @param {Uint8Array} key 32 bytes.
 * @param {Pick<typeof nodeCrypto, "createCipheriv" | "createDecipheriv">} [native]
 *   The functions of `node:crypto`. A test gives others.
 * @returns {import("./eme.js").BlockCipher}
 */
export function aes256(key, native = nodeCrypto) {
  // ECB has no IV. workerd refuses null, so the IV is empty.
  const iv = new Uint8Array(0);
  let encryptor;
  let decryptor;
  try {
    encryptor = native.createCipheriv("aes-256-ecb", key, iv);
    decryptor = native.createDecipheriv("aes-256-ecb", key, iv);
  } catch {
    return aes256js(key);
  }
  encryptor.setAutoPadding(false);
  decryptor.setAutoPadding(false);
  return {
    encrypt: (block) => encryptor.update(block),
    decrypt: (block) => decryptor.update(block),
  };
}

/**
 * AES-256 in ECB mode with no padding, in JavaScript, as FIPS-197. It is
 * slower than `node:crypto`, and its tables do not keep the time the same for
 * each key, but it runs in each runtime. EME uses it only for the names of
 * files.
 * @param {Uint8Array} key 32 bytes.
 * @returns {import("./eme.js").BlockCipher}
 */
export function aes256js(key) {
  if (key.length !== 32) {
    throw new RangeError("The key of AES-256 must have 32 bytes");
  }
  const { sbox, inverse } = tables();
  const w = expand(key, sbox);
  return {
    encrypt: (blocks) => each(blocks, (s) => encryptBlock(s, w, sbox)),
    decrypt: (blocks) => each(blocks, (s) => decryptBlock(s, w, inverse)),
  };
}

/**
 * Gives a copy of the blocks, with each block changed in place by `fn`.
 * @param {Uint8Array} blocks
 * @param {(state: Uint8Array) => void} fn
 * @returns {Uint8Array}
 */
function each(blocks, fn) {
  if (blocks.length % BLOCK_SIZE !== 0) {
    throw new RangeError("The data of AES-ECB must be blocks of 16 bytes");
  }
  // A copy: slice() of a Buffer gives a view of the same bytes.
  const out = new Uint8Array(blocks);
  for (let i = 0; i < out.length; i += BLOCK_SIZE) {
    fn(out.subarray(i, i + BLOCK_SIZE));
  }
  return out;
}

/** @type {{ sbox: Uint8Array, inverse: Uint8Array } | undefined} */
let cache;

/**
 * The S-box of AES and its inverse (FIPS-197, section 5.1.1): the inverse in
 * GF(2^8), then the affine transform. They are made at the first use, not at
 * the load of the module. p goes through each value other than 0 with the
 * generator 3, and q is its inverse.
 */
function tables() {
  if (cache) return cache;
  const sbox = new Uint8Array(256);
  const inverse = new Uint8Array(256);
  const rotl = (x, n) => ((x << n) | (x >> (8 - n))) & 0xff;
  let p = 1;
  let q = 1;
  do {
    // p = p * 3.
    p = p ^ xtime(p);
    // q = q / 3.
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const s = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 0x63;
    sbox[p] = s;
    inverse[s] = p;
  } while (p !== 1);
  // 0 has no inverse: the affine transform of 0.
  sbox[0] = 0x63;
  inverse[0x63] = 0;
  cache = { sbox, inverse };
  return cache;
}

/**
 * The multiplication by 2 in GF(2^8).
 * @param {number} x A byte.
 */
function xtime(x) {
  return ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
}

/**
 * The key schedule of AES-256 (FIPS-197, section 5.2): 15 round keys of 16
 * bytes, one after the other.
 * @param {Uint8Array} key 32 bytes.
 * @param {Uint8Array} sbox
 */
function expand(key, sbox) {
  const w = new Uint8Array((ROUNDS + 1) * BLOCK_SIZE);
  w.set(key);
  let rcon = 1;
  for (let i = 32; i < w.length; i += 4) {
    let t0 = w[i - 4];
    let t1 = w[i - 3];
    let t2 = w[i - 2];
    let t3 = w[i - 1];
    if (i % 32 === 0) {
      // RotWord, SubWord and Rcon.
      [t0, t1, t2, t3] = [sbox[t1] ^ rcon, sbox[t2], sbox[t3], sbox[t0]];
      rcon = xtime(rcon);
    } else if (i % 32 === 16) {
      // SubWord only, for a key of 8 words.
      [t0, t1, t2, t3] = [sbox[t0], sbox[t1], sbox[t2], sbox[t3]];
    }
    w[i] = w[i - 32] ^ t0;
    w[i + 1] = w[i - 31] ^ t1;
    w[i + 2] = w[i - 30] ^ t2;
    w[i + 3] = w[i - 29] ^ t3;
  }
  return w;
}

/**
 * @param {Uint8Array} s The state: 16 bytes, column after column.
 * @param {Uint8Array} w The round keys.
 * @param {number} round
 */
function addRoundKey(s, w, round) {
  const start = round * BLOCK_SIZE;
  for (let i = 0; i < BLOCK_SIZE; i++) s[i] ^= w[start + i];
}

/**
 * Puts each byte of the state through a table.
 * @param {Uint8Array} s
 * @param {Uint8Array} table
 */
function substitute(s, table) {
  for (let i = 0; i < BLOCK_SIZE; i++) s[i] = table[s[i]];
}

/**
 * Turns the row r of the state left by r bytes, or right with `inverse`.
 * @param {Uint8Array} s
 * @param {boolean} inverse
 */
function shiftRows(s, inverse) {
  const t = s.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const from = inverse ? (c + 4 - r) % 4 : (c + r) % 4;
      s[r + 4 * c] = t[r + 4 * from];
    }
  }
}

/** @param {Uint8Array} s */
function mixColumns(s) {
  for (let c = 0; c < 16; c += 4) {
    const [a0, a1, a2, a3] = [s[c], s[c + 1], s[c + 2], s[c + 3]];
    const all = a0 ^ a1 ^ a2 ^ a3;
    s[c] = a0 ^ all ^ xtime(a0 ^ a1);
    s[c + 1] = a1 ^ all ^ xtime(a1 ^ a2);
    s[c + 2] = a2 ^ all ^ xtime(a2 ^ a3);
    s[c + 3] = a3 ^ all ^ xtime(a3 ^ a0);
  }
}

/**
 * The inverse of `mixColumns`: the multiplications by 9, 11, 13 and 14.
 * @param {Uint8Array} s
 */
function inverseMixColumns(s) {
  for (let c = 0; c < 16; c += 4) {
    const a = [s[c], s[c + 1], s[c + 2], s[c + 3]];
    const times = a.map((x) => {
      const x2 = xtime(x);
      const x4 = xtime(x2);
      const x8 = xtime(x4);
      return { 9: x8 ^ x, 11: x8 ^ x2 ^ x, 13: x8 ^ x4 ^ x, 14: x8 ^ x4 ^ x2 };
    });
    for (let r = 0; r < 4; r++) {
      s[c + r] = times[r][14] ^ times[(r + 1) % 4][11] ^
        times[(r + 2) % 4][13] ^ times[(r + 3) % 4][9];
    }
  }
}

/**
 * @param {Uint8Array} s One block, which changes.
 * @param {Uint8Array} w
 * @param {Uint8Array} sbox
 */
function encryptBlock(s, w, sbox) {
  addRoundKey(s, w, 0);
  for (let round = 1; round < ROUNDS; round++) {
    substitute(s, sbox);
    shiftRows(s, false);
    mixColumns(s);
    addRoundKey(s, w, round);
  }
  substitute(s, sbox);
  shiftRows(s, false);
  addRoundKey(s, w, ROUNDS);
}

/**
 * @param {Uint8Array} s One block, which changes.
 * @param {Uint8Array} w
 * @param {Uint8Array} inverse The inverse S-box.
 */
function decryptBlock(s, w, inverse) {
  addRoundKey(s, w, ROUNDS);
  for (let round = ROUNDS - 1; round > 0; round--) {
    shiftRows(s, true);
    substitute(s, inverse);
    addRoundKey(s, w, round);
    inverseMixColumns(s);
  }
  shiftRows(s, true);
  substitute(s, inverse);
  addRoundKey(s, w, 0);
}
