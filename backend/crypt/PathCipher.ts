import { AES } from "https://esm.sh/aes-js@3.1.2";
import {
  pad,
  Padding,
  unpad,
} from "https://deno.land/x/crypto/src/utils/padding.ts";
import { default as decodeBase32 } from "https://esm.sh/base32-decode@1.0.0";
import { default as encodeBase32 } from "https://esm.sh/base32-encode@2.0.0";
import { Decrypt, Encrypt } from "./eme.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface PathCipherOptions {
  nameKey?: Uint8Array;
  nameTweak?: Uint8Array;
}

export default function PathCipher(
  { nameKey, nameTweak }: PathCipherOptions = {},
) {
  if (nameKey === undefined || nameTweak === undefined) {
    throw new Error("nameKey and nameTweak must be specified");
  }
  // Name Cipher Fuctions
  // TODO: Switch to https://github.com/invisal/god_crypto/blob/master/src/aes/aes_wc.ts
  const nameCipher = new AES(nameKey);

  function encryptName(name: string) {
    if (name === "") return "";
    const ciphertext = encoder.encode(name);
    const paddedCipherText = pad(ciphertext, Padding.PKCS7, 16);
    const rawCipherText = Encrypt(nameCipher, nameTweak!, paddedCipherText);

    const encodedCipher = encodeBase32(rawCipherText, "RFC4648-HEX");
    return encodedCipher.replace(/=+$/, "").toLowerCase();
  }

  function encrypt(path: string) {
    return path
      .split("/")
      .map(encryptName)
      .join("/");
  }
  function decryptName(name: string) {
    const rawCipherText = new Uint8Array(
      decodeBase32(name.toUpperCase(), "RFC4648-HEX"),
    );
    const paddedPlaintext = Decrypt(nameCipher, nameTweak!, rawCipherText);
    return decoder.decode(unpad(paddedPlaintext, Padding.PKCS7, 16));
  }

  function decrypt(path: string) {
    return path
      .split("/")
      .map(decryptName)
      .join("/");
  }

  return {
    encryptName,
    decryptName,
    encrypt,
    decrypt,
  };
}
