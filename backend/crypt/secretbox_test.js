import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  add,
  decryptedSize,
  DecryptionStream,
  encryptedSize,
  EncryptionStream,
  Errors,
  increment,
} from "./secretbox.js";

/** The options of rclone crypt. */
const RCLONE = {
  magic: new TextEncoder().encode("RCLONE\x00\x00"),
  blockSize: 64 * 1024,
};

/**
 * The files of TestEncryptData of rclone (backend/crypt/cipher_test.go): the
 * key of zero bytes, and the nonce 1, 2, ..., 24.
 */
const header = [
  0x52,
  0x43,
  0x4c,
  0x4f,
  0x4e,
  0x45,
  0x00,
  0x00,
  0x01,
  0x02,
  0x03,
  0x04,
  0x05,
  0x06,
  0x07,
  0x08,
  0x09,
  0x0a,
  0x0b,
  0x0c,
  0x0d,
  0x0e,
  0x0f,
  0x10,
  0x11,
  0x12,
  0x13,
  0x14,
  0x15,
  0x16,
  0x17,
  0x18,
];
const file0 = Uint8Array.from(header);
const file1 = Uint8Array.from([
  ...header,
  0x09,
  0x5b,
  0x44,
  0x6c,
  0xd6,
  0x23,
  0x7b,
  0xbc,
  0xb0,
  0x8d,
  0x09,
  0xfb,
  0x52,
  0x4c,
  0xe5,
  0x65,
  0xAA,
]);
const file16 = Uint8Array.from([
  ...header,
  0xb9,
  0xc4,
  0x55,
  0x2a,
  0x27,
  0x10,
  0x06,
  0x29,
  0x18,
  0x96,
  0x0a,
  0x3e,
  0x60,
  0x8c,
  0x29,
  0xb9,
  0xaa,
  0x8a,
  0x5e,
  0x1e,
  0x16,
  0x5b,
  0x6d,
  0x07,
  0x5d,
  0xe4,
  0xe9,
  0xbb,
  0x36,
  0x7f,
  0xd6,
  0xd4,
]);
const zeroKey = new Uint8Array(32);

/**
 * Sends the chunks through a stream, and gives the bytes at the end.
 * @param {Uint8Array[]} chunks
 * @param {TransformStream} stream
 */
async function through(chunks, stream) {
  const body = ReadableStream.from(chunks).pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * Cuts the bytes into chunks at the points.
 * @param {Uint8Array} bytes
 * @param {number[]} cuts
 */
function cut(bytes, cuts) {
  const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))]
    .sort((a, b) => a - b);
  const chunks = [];
  let start = 0;
  for (const point of points) {
    chunks.push(bytes.slice(start, point));
    start = point;
  }
  chunks.push(bytes.slice(start));
  return chunks;
}

test("decrypts the files of rclone (TestEncryptData)", async () => {
  for (
    const [file, data] of [
      [file0, []],
      [file1, [1]],
      [file16, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]],
    ]
  ) {
    // In one chunk, and in chunks of 1 byte.
    for (
      const chunks of [
        [file],
        [...file].map((byte) => Uint8Array.of(byte)),
      ]
    ) {
      const plain = await through(
        chunks,
        new DecryptionStream(zeroKey, RCLONE),
      );
      assert.deepEqual(plain, Uint8Array.from(data));
    }
  }
});

test("gives the errors of rclone for data that is not correct", async () => {
  const decrypt = (bytes) =>
    through([bytes], new DecryptionStream(zeroKey, RCLONE));

  // Each part of the header is too short (TestNewDecrypter).
  for (let length = 0; length < file0.length; length++) {
    await assert.rejects(decrypt(file0.slice(0, length)), {
      message: Errors.TOO_SHORT,
    });
  }
  // A change of each byte of the magic (TestNewDecrypter).
  for (let index = 0; index < 8; index++) {
    const bad = file0.slice();
    bad[index] ^= 1;
    await assert.rejects(decrypt(bad), { message: Errors.BAD_MAGIC });
  }
  // A block of 16 bytes or less has no data after its tag.
  await assert.rejects(decrypt(file1.slice(0, 48)), {
    message: Errors.BAD_HEADER,
  });
  // A change of the data of a block, or a different key.
  const changed = file16.slice();
  changed[40] ^= 1;
  await assert.rejects(decrypt(changed), { message: Errors.BAD_BLOCK });
  await assert.rejects(
    through([file16], new DecryptionStream(new Uint8Array(32).fill(1), RCLONE)),
    { message: Errors.BAD_BLOCK },
  );
});

test("gives the sizes of rclone (TestEncryptedSize, TestDecryptedSize)", () => {
  for (
    const [size, encrypted] of [
      [0, 32],
      [1, 32 + 16 + 1],
      [65536, 32 + 16 + 65536],
      [65537, 32 + 16 + 65536 + 16 + 1],
      [2 ** 20, 32 + 16 * (16 + 65536)],
      [2 ** 20 + 65535, 32 + 16 * (16 + 65536) + 16 + 65535],
      [2 ** 30, 32 + 16384 * (16 + 65536)],
      [2 ** 40 + 1, 32 + 16777216 * (16 + 65536) + 16 + 1],
    ]
  ) {
    assert.equal(encryptedSize(size, RCLONE), encrypted, `${size}`);
    assert.equal(decryptedSize(encrypted, RCLONE), size, `${encrypted}`);
  }
  for (
    const [size, message] of [
      [0, Errors.TOO_SHORT],
      [1, Errors.TOO_SHORT],
      [7, Errors.TOO_SHORT],
      [32 + 1, Errors.BAD_HEADER],
      [32 + 16, Errors.BAD_HEADER],
      [32 + 16 + 65536 + 1, Errors.BAD_HEADER],
      [32 + 16 + 65536 + 16, Errors.BAD_HEADER],
    ]
  ) {
    assert.throws(() => decryptedSize(size, RCLONE), { message }, `${size}`);
  }
});

test("decrypts what it encrypts, for each split of the chunks", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.uint8Array({ maxLength: 8 }),
      fc.integer({ min: 1, max: 40 }),
      fc.uint8Array({ maxLength: 300 }),
      fc.array(fc.nat(), { maxLength: 5 }),
      fc.array(fc.nat(), { maxLength: 5 }),
      async (key, magic, blockSize, content, cuts, cuts2) => {
        const options = { magic, blockSize };
        const encrypted = await through(
          cut(content, cuts),
          new EncryptionStream(key, options),
        );
        assert.equal(encrypted.length, encryptedSize(content.length, options));
        assert.equal(decryptedSize(encrypted.length, options), content.length);

        const decrypted = await through(
          cut(encrypted, cuts2),
          new DecryptionStream(key, options),
        );
        assert.deepEqual(decrypted, content);
      },
    ),
  );
});

test("decrypts what it encrypts, at the size of the blocks of rclone", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  for (const size of [0, 1, 65535, 65536, 65537, 2 * 65536 + 7]) {
    const content = new Uint8Array(size).map((_, index) => index * 31 + 7);
    const encrypted = await through(
      [content],
      new EncryptionStream(key, RCLONE),
    );
    assert.equal(encrypted.length, encryptedSize(size, RCLONE));
    assert.deepEqual(
      await through([encrypted], new DecryptionStream(key, RCLONE)),
      content,
    );
  }
});

test("adds a number to a nonce as the same number of increments", () => {
  // Bytes of 0xff make carries into the next bytes.
  const byte = fc.oneof(fc.constant(0xff), fc.integer({ min: 0, max: 255 }));
  fc.assert(
    fc.property(
      fc.array(byte, { minLength: 24, maxLength: 24 }),
      fc.nat(700),
      (bytes, number) => {
        const expected = Uint8Array.from(bytes);
        for (let index = 0; index < number; index++) increment(expected);
        assert.deepEqual(add(Uint8Array.from(bytes), number), expected);
      },
    ),
  );
  // A carry out of the last byte goes away, as in rclone.
  assert.deepEqual(add(new Uint8Array(24).fill(0xff), 1), new Uint8Array(24));
});

test("decrypts the blocks of a file from any block", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.integer({ min: 1, max: 16 }),
      fc.uint8Array({ maxLength: 300 }),
      fc.nat(),
      async (key, blockSize, content, choice) => {
        const options = { magic: RCLONE.magic, blockSize };
        const encrypted = await through(
          [content],
          new EncryptionStream(key, options),
        );
        const headerSize = RCLONE.magic.length + 24;
        const nonce = encrypted.slice(RCLONE.magic.length, headerSize);
        const blocks = Math.ceil(content.length / blockSize);
        const block = blocks ? choice % blocks : 0;
        const decrypted = await through(
          [encrypted.subarray(headerSize + block * (blockSize + 16))],
          new DecryptionStream(key, { ...options, nonce, block }),
        );
        assert.deepEqual(decrypted, content.subarray(block * blockSize));
      },
    ),
  );
});
