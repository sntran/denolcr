const ALGORITHM = "AES-CTR";

const KEY = await crypto.subtle.importKey(
  "raw",
  // https://github.com/rclone/rclone/blob/10c884552caab3d3d8484ed3401e94f983a23f93/fs/config/obscure/obscure.go#L17-L22
  Uint8Array.from([
    0x9c,
    0x93,
    0x5b,
    0x48,
    0x73,
    0x0a,
    0x55,
    0x4d,
    0x6b,
    0xfd,
    0x7c,
    0x63,
    0xc8,
    0x86,
    0xa9,
    0x2b,
    0xd3,
    0x90,
    0x19,
    0x8e,
    0xb8,
    0x12,
    0x8a,
    0xfb,
    0xf4,
    0xde,
    0x16,
    0x2b,
    0x8b,
    0x95,
    0xf6,
    0x38,
  ]),
  ALGORITHM,
  false,
  ["encrypt", "decrypt"],
);

const BlockSize = 16;

/**
 * Obscrures a password by encrypting them and writing them out in base64.
 * @param {string} password
 * @returns {Promise<Response>} A Response containing the obscured password.
 */
export async function obscure(password) {
  const plaintext = new TextEncoder().encode(password);
  // Constructs the initial empty ciphertext buffer containing the IV and the encrypted text.
  const ciphertext = new Uint8Array(BlockSize + plaintext.length);
  // Constructs the IV buffer.
  const iv = ciphertext.subarray(0, BlockSize);
  // Fills IV buffer with random bytes.
  crypto.getRandomValues(iv);
  // Encrypts the plaintext into the encrypted buffer.
  const encrypted = await crypto.subtle.encrypt(
    {
      name: ALGORITHM,
      counter: iv,
      length: 64,
    },
    KEY,
    plaintext,
  );
  // Copies the encrypted buffer into the ciphertext buffer.
  ciphertext.set(new Uint8Array(encrypted), BlockSize);
  // Encodes the ciphertext buffer into a base64 string.
  const encoded = btoa(String.fromCharCode(...ciphertext));

  return new Response(encoded);
}

/**
 * Reveals obscured text by decrypting them
 * @param {string} cipherText
 * @returns {Promise<Response>}
 */
export async function reveal(cipherText) {
  // Decodes the base64 string into a ciphertext buffer.
  const bytes = base64(cipherText);
  // Constructs the IV buffer from the first block of the ciphertext buffer.
  const iv = bytes.subarray(0, BlockSize);
  // Constructs the encrypted buffer from the remaining blocks of the ciphertext buffer.
  const data = bytes.subarray(BlockSize);
  // Decrypts the encrypted buffer into the plaintext buffer.
  const plaintext = await crypto.subtle.decrypt(
    {
      name: ALGORITHM,
      counter: iv,
      length: 64,
    },
    KEY,
    data,
  );

  return new Response(plaintext);
}

/**
 * Encodes a string into a base64 Uint8Array.
 * @param {string} s
 * @returns {Uint8Array}
 */
function base64(s) {
  // Replace non-url compatible chars with base64 standard chars
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  // Pad out with standard base64 required padding characters
  const pad = s.length % 4;
  if (pad != 0) {
    s += "====".substring(0, 4 - pad);
  }
  return new Uint8Array(atob(s).split("").map((c) => c.charCodeAt(0)));
}
