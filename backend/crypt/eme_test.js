import { test } from "node:test";
import { aes256, aes256js } from "./aes.js";
import assert from "node:assert/strict";
import fc from "fast-check";

import { decrypt, encrypt } from "./eme.js";

/**
 * Makes the bytes of a text in hexadecimal. The text can have spaces and
 * line breaks.
 * @param {string} text
 * @returns {Uint8Array}
 */
function hex(text) {
  const digits = text.replace(/\s/g, "");
  return Uint8Array.from(
    { length: digits.length / 2 },
    (_, i) => parseInt(digits.slice(i * 2, i * 2 + 2), 16),
  );
}

/**
 * Gives the blocks of 16 bytes of the data, as views.
 * @param {Uint8Array} data
 * @returns {Uint8Array[]}
 */
function blocks(data) {
  return Array.from(
    { length: data.length / 16 },
    (_, j) => data.subarray(j * 16, (j + 1) * 16),
  );
}

// The vectors of https://github.com/rfjakob/eme (eme_test.go), the library of
// rclone: the key, the tweak and the input are zeros.
const VECTORS = {
  16: hex("f1b9ce8ca15a4ba9fb476905434b9fd3"),
  2048: hex(`
  630500884158a8d41216aaa6351e92ea7ca540a949e73f1d6069afef372eae226d426d8f
  4dbbce505051fcd596e7b32cdd1e44a40bcce0887ebbc160f779dafbb68bc25a40040987
  cdb5aba19b956e11dd69d7ce74d1d8788903254217300f3afd9a92cea395a89fd842256d
  3919ac303c1d1a21ec44cb2898acabb3d0e04e05845e9183a64b4148f9614f62f79fa971
  799c896c58cd2b285cb00e40720b5c118ef1c0dbf5e51f09cd10db672b9c22c53d4bf5da
  bf16cfcbc382e3209e7ba27955b2afa055924d2155319205f964492e0e88172f4ffadca3
  5cd3e694fd3d803f610edc1696113996749bdb2a2dfb8fbd92f0ef723146f93d969d1de4
  cc1c19efa33785f135a1203005ba2208fcd6b9f0d0e942993671b0c5baefe7ed0bbfe070
  a9e1d26eed37228ceda64b70c25a59fd040703acc385c6e4093a8e258984371c2d811c01
  723b87c820a55470501b245d97a0c7564c44e1e31a89457c1125198d27ac2dec67f7237c
  781f9f622e420da471af577fa6ad8014bb1dad52dc450e37ebeeb1f1b7ba3c3d5796c664
  6bd052fe66cf61d22f6e58efcbf0328d3b6e1088603e54bfd2da241c970fec58c7d21fc2
  b2f1b4b79552a92500a7e6848a22ec47ee362cef9787af3b26439470992c8d103997395a
  efeff10802673d4630009e4e5ed26038d5f05c589e64046274d5ff133398e4bab08ca71c
  0ce93dbd0657785b150c9e418339e8e47d02ae7322b5b55364dfe10dd02d54dc5f2dbe82
  e55bcf0503b30d709301fc7f63cd15e7e1245189405b1364b6074c0e493f7beb27385986
  4e95643c7d914279d95f220247618b7a5c896d604e9ce88e0a3ab434cfe97cabc520b20e
  2fffee958972e82e98b952cbf3567be560a8385e520b636829252cae16ac882d1d3dde44
  7a90af52be7967f357a36382c9672a659ed0ffae9ee7b969c8c788f982fbd524efb6b852
  f65be5f371032691e9ef6e5a217607cf990e5351b251f841834045d9bd54633e8bb0d195
  69377f805857a503a2642dfc06e2063dfd465dcae83b1e362394cdf20bd6a6d5dd0bacad
  7f2d407e597b004e90683bfc23b92796bb0cdf67752765dbba2d1332848adcb83e60b7f3
  f8c397a3aa5de08bf491676a18ee4a6ed9b342b33c081794365a72668f273a655e150fa3
  6686aa5dfbc87ccda9cbe7982e531044cd9fcea68ca1a5034ee64e0558b7c6af56808c03
  43506dccf39e4ca8634518e6420c107b7d5fe89943e9f40044b2ae7f047d97275ec4763b
  41416fb3faff897e6ee0047f97b215b02ee09a3f533cba2ee131a0aa68772860759325ea
  4dc7ab86528d0aff55f96d00a908ea32f9fa8bd0640d632bf0d812f43beb03e6c6d4a654
  b41f27143fde4aa7ed16ae4bba939fbed8ae28dace83fcb49fd3ca910512902fc6964199
  68e260901796f3af75d059c6e93a8f53b445f921e60d9429007c78107309a86102b923db
  b2f1fa04f84539c7c58ed45b40d4b267541d8f2f932ae75dfc13ef906089e1c847635aaa
  da201e32301f326a733f4a99caa56fa00ccd6de2752a4495408bb4c930eaf84c97a28767
  a036f65627efa868adeee1cf47840e67ac4489381da1513dd3d1707a5ad91ac4ba1c3571
  4b1cd77e05551612cdfb88187a5a39afd5b2a54f88aeb9605c1e01cd7a976a168c6e40ed
  dcb20f09fe54a07a7c971eda08789b41e450f46a30c2b3494f30a06073631d151ae04879
  3fe32ff08a08b8693d1da71451f7ff2438d7a521f8c97e4bc8ee744c1574d296c799d3f9
  4e81522ce81def780660cee061d3110c1f18133dca1daabb2268aad76327f3cb6ae8c96f
  c66b5506f5644f2652d022d7b616209970f78b8e5c9a74f5d1fc31037d01733bff097a66
  1d4331adc087b84e32afb9d82a0614ea459022918f8ca60e74b7c6865d3e86e6ae4acf95
  46985dc5ccf242dd9ab0486bde99a1e656499cbfceef8de5beafda89965bf208c70f4a0f
  8f677792962b09e0a355d53bbacb4a7acc16e50aa483994d85ca7e28a34ee52843d4f27a
  cfb3b5347b89099fd01642b605f87f82283bb146aa319048462fe11a71d0fa064e825f69
  a502ae539240b13a2568383f80c30ebb9a29d2de4c45e6405bd8d1586fe5eef0477d3c21
  434b3471c0f864dd4c2f135278645ef1b1ebb4d6954f92763d787ad3d0bb48409782cd80
  3a877027ae105511cdaefe0110f9f6c65f2a34ad12532f4715c0341346dc06bcc4bb0e5c
  04ffdfd3f625e7e3811a760a2cfa9cbe1c2914882c192b793aeeb3ab8b03fd8be7e248fc
  9e5aa0c651d4bb5318c8a266b735ddc167d837499a3b38dcdfe188e25172eb974eb0eff2
  0cc5c6e42e505fea7a3b6edfdf93b7062737ea00f72a415c4dfd3cd4fab2dad812d88d02
  690f606b52dcfb0ab220dc65a7dee6f31e951324a1c442adfe9cf672646876bedc2c2cb7
  1bac583f3cf4ea6769eb54d22bf22b0d908a297caa13767ed14c44b738799e821885b2b2
  988a9b88a2f35bf8d307543af9007fadcfcc273f8029c2fe3d59449c5f193ca7f8986ca7
  451d9a3ee14335b10868421b64ea1605d48d4fc22e378f82b7fe3e88aada30b4c545408b
  87b24511e371f25d1a94e7b78a6a7aec848e6f82614f96ef5ed8705e0adec0f889c1860c
  f8211d716fddf319862290019a4387fb77c89a5ae7d0074fa72024f2e5096d39ebac8e8e
  d02191879585394987fea3a07a720d6880910629cdcd83a02ffd98830d2f57ee6c53b5cf
  edb42ec7c3d925cf3080c343f21711a90f117e9eaf91402d09b83e83bd18d1c4e3d165a8
  b9bac7adca12cb0147bfc4c6e2166c57b8182e63fbc698881ed5b329eb491eb98050a922
  c15804021013bf08942db9ee6d8f2a2c4eb93771340ed9e323d09e4256b7e5ac
  `),
};

test("the vectors of rfjakob/eme, with AES of node:crypto and of JavaScript", () => {
  for (
    const cipher of [aes256(new Uint8Array(32)), aes256js(new Uint8Array(32))]
  ) {
    const tweak = new Uint8Array(16);
    for (const [size, expected] of Object.entries(VECTORS)) {
      const zeros = new Uint8Array(Number(size));
      assert.deepEqual(new Uint8Array(encrypt(cipher, tweak, zeros)), expected);
      assert.deepEqual(new Uint8Array(decrypt(cipher, tweak, expected)), zeros);
    }
  }
});

const KEY = fc.uint8Array({ minLength: 32, maxLength: 32 });
const TWEAK = fc.uint8Array({ minLength: 16, maxLength: 16 });
const DATA = fc.integer({ min: 1, max: 128 }).chain((blocks) =>
  fc.uint8Array({ minLength: blocks * 16, maxLength: blocks * 16 })
);

test("decrypt gives the data that encrypt took", () => {
  fc.assert(
    fc.property(KEY, TWEAK, DATA, (key, tweak, data) => {
      const cipher = aes256(key);
      const encrypted = encrypt(cipher, tweak, data);
      assert.deepEqual(encrypted.length, data.length);
      assert.deepEqual(decrypt(cipher, tweak, encrypted), data);
    }),
  );
});

test("a change of one bit of the input or of the tweak changes each block", () => {
  fc.assert(
    fc.property(KEY, TWEAK, DATA, fc.nat(), (key, tweak, data, bit) => {
      const cipher = aes256(key);
      const before = blocks(encrypt(cipher, tweak, data));

      const changed = data.slice();
      changed[(bit >> 3) % data.length] ^= 1 << (bit & 7);
      blocks(encrypt(cipher, tweak, changed)).forEach((block, j) =>
        assert.notDeepEqual(block, before[j])
      );

      const otherTweak = tweak.slice();
      otherTweak[(bit >> 3) % 16] ^= 1 << (bit & 7);
      blocks(encrypt(cipher, otherTweak, data)).forEach((block, j) =>
        assert.notDeepEqual(block, before[j])
      );
    }),
  );
});

test("encrypt and decrypt do not change their input, also a Buffer", () => {
  const cipher = aes256(new Uint8Array(32));
  // The slice of a Buffer is a view, not a copy.
  for (const make of [(n) => new Uint8Array(n), (n) => Buffer.alloc(n)]) {
    const tweak = make(16);
    const data = make(64).fill(7);
    const encrypted = encrypt(cipher, tweak, data);
    assert.deepEqual(
      decrypt(cipher, tweak, encrypted),
      new Uint8Array(64).fill(7),
    );
    assert.deepEqual(new Uint8Array(tweak), new Uint8Array(16));
    assert.deepEqual(new Uint8Array(data), new Uint8Array(64).fill(7));
  }
});

test("the tweak is 16 bytes, and the data are 1 to 128 blocks", () => {
  const cipher = aes256(new Uint8Array(32));
  const tweak = new Uint8Array(16);
  for (const f of [encrypt, decrypt]) {
    assert.throws(() => f(cipher, new Uint8Array(15), new Uint8Array(16)), {
      name: "TypeError",
      message: "EME: the tweak must be 16 bytes.",
    });
    assert.throws(() => f(cipher, tweak, [0, 0]), {
      name: "TypeError",
      message: "EME: the data must be a Uint8Array.",
    });
    for (const size of [0, 15, 17, 2064]) {
      assert.throws(() => f(cipher, tweak, new Uint8Array(size)), {
        name: "RangeError",
        message:
          `EME: the data must be 1 to 128 blocks of 16 bytes, not ${size} bytes.`,
      });
    }
  }
});
