import { test } from "node:test";
import assert from "node:assert/strict";
import encodeBase32 from "base32-encode";
import fc from "fast-check";

import PathCipher from "./PathCipher.js";

// rclone tests its names with keys of zero bytes: the keys of an empty
// password (backend/crypt/cipher_test.go).
const cipher = PathCipher({
  nameKey: new Uint8Array(32),
  nameTweak: new Uint8Array(16),
});

test("encrypts the names as rclone (TestEncryptSegmentBase32)", () => {
  const vectors = {
    "": "",
    "1": "p0e52nreeaj0a5ea7s64m4j72s",
    "12": "l42g6771hnv3an9cgc8cr2n1ng",
    "123": "qgm4avr35m5loi1th53ato71v0",
    "1234": "8ivr2e9plj3c3esisjpdisikos",
    "12345": "rh9vu63q3o29eqmj4bg6gg7s44",
    "123456": "bn717l3alepn75b2fb2ejmi4b4",
    "1234567": "n6bo9jmb1qe3b1ogtj5qkf19k8",
    "12345678": "u9t24j7uaq94dh5q53m3s4t9ok",
    "123456789": "37hn305g6j12d1g0kkrl7ekbs4",
    "1234567890": "ot8d91eplaglb62k2b1trm2qv0",
    "12345678901": "h168vvrgb53qnrtvvmb378qrcs",
    "123456789012": "s3hsdf9e29ithrqbjqu01t8q2s",
    "1234567890123": "cf3jimlv1q2oc553mv7s3mh3eo",
    "12345678901234": "moq0uqdlqrblrc5pa5u5c7hq9g",
    "123456789012345": "eeam3li4rnommi3a762h5n7meg",
    "1234567890123456": "mijbj0frqf6ms7frcr6bd9h0env53jv96pjaaoirk7forcgpt70g",
  };
  for (const [name, encrypted] of Object.entries(vectors)) {
    assert.equal(cipher.encryptName(name), encrypted, name);
    assert.equal(cipher.decryptName(encrypted), name, encrypted);
    // The decryption does not see the case.
    assert.equal(cipher.decryptName(encrypted.toUpperCase()), name);
  }
});

test("encrypts the paths as rclone (TestStandardEncryptFileNameBase32)", () => {
  const vectors = {
    "1/12": "p0e52nreeaj0a5ea7s64m4j72s/l42g6771hnv3an9cgc8cr2n1ng",
    "1/12/123": "p0e52nreeaj0a5ea7s64m4j72s/l42g6771hnv3an9cgc8cr2n1ng/" +
      "qgm4avr35m5loi1th53ato71v0",
    "/1/12/": "/p0e52nreeaj0a5ea7s64m4j72s/l42g6771hnv3an9cgc8cr2n1ng/",
  };
  for (const [path, encrypted] of Object.entries(vectors)) {
    assert.equal(cipher.encrypt(path), encrypted);
    assert.equal(cipher.decrypt(encrypted), path);
  }
});

test("refuses the names that rclone refuses (TestDecryptSegmentBase32)", () => {
  const base32 = (text) =>
    encodeBase32(new TextEncoder().encode(text), "RFC4648-HEX", {
      padding: false,
    }).toLowerCase();
  for (
    const name of [
      "64=",
      "!",
      "hello=hello",
      "a".repeat(3328),
      base32("a"),
      base32("123456789abcdef"),
      base32("123456789abcdef0"),
      // One character more than an encrypted name.
      base32("1") + "p0e52nreeaj0a5ea7s64m4j72s",
    ]
  ) {
    assert.throws(() => cipher.decryptName(name), Error, name);
  }
});

test("decrypts each name that it encrypts", () => {
  const key = fc.uint8Array({ minLength: 32, maxLength: 32 });
  const tweak = fc.uint8Array({ minLength: 16, maxLength: 16 });
  fc.assert(
    fc.property(
      key,
      tweak,
      fc.fullUnicodeString({ maxLength: 200 }),
      (nameKey, nameTweak, name) => {
        fc.pre(!name.includes("/"));
        const names = PathCipher({ nameKey, nameTweak });
        const encrypted = names.encryptName(name);
        assert.match(encrypted, /^[0-9a-v]*$/);
        assert.equal(names.decryptName(encrypted), name);
      },
    ),
  );
});
