// EME (ECB-Mix-ECB) is the wide-block encryption mode of Halevi and Rogaway,
// "A Parallelizable Enciphering Mode" (2003): https://eprint.iacr.org/2003/147
//
// EME makes one cipher for 1 to 128 blocks (16 to 2048 bytes) from a block
// cipher of 16 bytes, such as AES. Each bit of the output changes with each
// bit of the input and of the tweak.
//
// rclone encrypts each name of a file with EME and AES-256, through the
// library https://github.com/rfjakob/eme. This module does the same steps.
// The names are the names of the paper: P is the input, C is the output, T
// is the tweak, and E is the block cipher. Encryption and decryption have
// the same steps: only the direction of E changes.

/** The size of one block, in bytes. */
const BLOCK_SIZE = 16;

/** The largest input, in blocks: 2048 bytes. */
const MAX_BLOCKS = 128;

/**
 * A block cipher of 16 bytes with its key, for example `new AES(key)` of
 * `aes-js`. Each function takes one block and gives a new block. It does not
 * change its input.
 * @typedef {Object} BlockCipher
 * @property {(block: Uint8Array) => Uint8Array} encrypt
 * @property {(block: Uint8Array) => Uint8Array} decrypt
 */

/**
 * Encrypts the data with EME.
 * @param {BlockCipher} cipher The block cipher, with the key.
 * @param {Uint8Array} tweak 16 bytes.
 * @param {Uint8Array} data 1 to 128 blocks of 16 bytes.
 * @returns {Uint8Array} The encrypted data, a new array of the same size.
 */
export function encrypt(cipher, tweak, data) {
  return transform(cipher, tweak, data, (block) => cipher.encrypt(block));
}

/**
 * Decrypts the data with EME.
 * @param {BlockCipher} cipher The block cipher, with the key.
 * @param {Uint8Array} tweak 16 bytes.
 * @param {Uint8Array} data 1 to 128 blocks of 16 bytes.
 * @returns {Uint8Array} The decrypted data, a new array of the same size.
 */
export function decrypt(cipher, tweak, data) {
  return transform(cipher, tweak, data, (block) => cipher.decrypt(block));
}

/**
 * The steps of EME.
 * @param {BlockCipher} cipher The block cipher. The table L uses its
 *   encryption in the two directions.
 * @param {Uint8Array} T The tweak.
 * @param {Uint8Array} P The input.
 * @param {(block: Uint8Array) => Uint8Array} E The block cipher, in the
 *   direction of the transform.
 * @returns {Uint8Array} C, the output.
 */
function transform(cipher, T, P, E) {
  check(T, P);
  const m = P.length / BLOCK_SIZE;
  const L = table(cipher, m);
  const C = new Uint8Array(P.length);

  // PPP_j = E(P_j xor L_j), and MP = T xor PPP_1 xor ... xor PPP_m.
  const MP = T.slice();
  for (let j = 0; j < m; j++) {
    const PPP = E(xor(block(P, j).slice(), L[j]));
    C.set(PPP, j * BLOCK_SIZE);
    xor(MP, PPP);
  }

  // MC = E(MP), and the mask M = MP xor MC.
  const MC = E(MP);
  const M = xor(MP.slice(), MC);

  // CCC_j = PPP_j xor 2^(j-1) M for j = 2 to m, in place in C.
  // CCC_1 = MC xor T xor CCC_2 xor ... xor CCC_m.
  const CCC1 = xor(MC.slice(), T);
  for (let j = 1; j < m; j++) {
    xor(CCC1, xor(block(C, j), double(M)));
  }
  C.set(CCC1, 0);

  // C_j = E(CCC_j) xor L_j.
  for (let j = 0; j < m; j++) {
    const Cj = block(C, j);
    Cj.set(E(Cj));
    xor(Cj, L[j]);
  }

  return C;
}

/**
 * The table of L for m blocks. The paper sets L = 2 E(0), and the block j
 * (from 1) uses 2^(j-1) L. Thus L[0] is L, L[1] is 2 L, and so on.
 * @param {BlockCipher} cipher
 * @param {number} m
 * @returns {Uint8Array[]}
 */
function table(cipher, m) {
  const L = cipher.encrypt(new Uint8Array(BLOCK_SIZE)).slice();
  return Array.from({ length: m }, () => double(L).slice());
}

/**
 * Multiplies the block by 2 in GF(2^128), in place, as `multByTwo` of the
 * draft EME-32: the bytes are little-endian, and a carry out of the last byte
 * adds the polynomial 135 (x^7 + x^2 + x + 1) to the first byte. No branch
 * depends on the data.
 * @param {Uint8Array} block
 * @returns {Uint8Array} The same block.
 */
function double(block) {
  const carry = block[BLOCK_SIZE - 1] >> 7;
  for (let i = BLOCK_SIZE - 1; i > 0; i--) {
    block[i] = (block[i] << 1) | (block[i - 1] >> 7);
  }
  block[0] = (block[0] << 1) ^ (135 * carry);
  return block;
}

/**
 * Puts `a` xor `b` in `a`.
 * @param {Uint8Array} a A block, which changes.
 * @param {Uint8Array} b A block.
 * @returns {Uint8Array} The block `a`.
 */
function xor(a, b) {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    a[i] ^= b[i];
  }
  return a;
}

/**
 * Gives the block j (from 0) of the data, as a view: a change of the view
 * changes the data.
 * @param {Uint8Array} data
 * @param {number} j
 * @returns {Uint8Array}
 */
function block(data, j) {
  return data.subarray(j * BLOCK_SIZE, (j + 1) * BLOCK_SIZE);
}

/**
 * Makes sure that the tweak and the data have a size that EME accepts.
 * @param {Uint8Array} tweak
 * @param {Uint8Array} data
 */
function check(tweak, data) {
  if (!(tweak instanceof Uint8Array) || tweak.length !== BLOCK_SIZE) {
    throw new TypeError(`EME: the tweak must be ${BLOCK_SIZE} bytes.`);
  }
  if (!(data instanceof Uint8Array)) {
    throw new TypeError("EME: the data must be a Uint8Array.");
  }
  const blocks = data.length / BLOCK_SIZE;
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > MAX_BLOCKS) {
    throw new RangeError(
      `EME: the data must be 1 to ${MAX_BLOCKS} blocks of ${BLOCK_SIZE} ` +
        `bytes, not ${data.length} bytes.`,
    );
  }
}
