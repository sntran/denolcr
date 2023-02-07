import { base64url } from "../../deps.ts";

const subtle = crypto.subtle;

const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const keyUsages: KeyUsage[] = ["sign"];

const header = btoa(JSON.stringify({
  alg: "RS256",
  typ: "JWT"
}));

const encoder = new TextEncoder();

export type ServiceAccount = {
  client_email: string;
  private_key_id: string;
  private_key: string;
}

/**
 * Generates a JWT for a Service Account with specified scopes.
 */
export async function createJWT(serviceAccount: ServiceAccount, scopes: string[]): Promise<string> {
  const { client_email, private_key} = serviceAccount;

  const now: number = Math.floor(Date.now() / 1000);
  const payload = {
    iss: client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const jwt = `${header}.${btoa(JSON.stringify(payload))}`;
  const key: CryptoKey = await importPrivateKey(private_key);

  const signature: ArrayBuffer = await subtle.sign(algorithm, key, encoder.encode(jwt));
  const signatureEncoded: string = base64url.encode(new Uint8Array(signature));

  return `${jwt}.${signatureEncoded}`;
}

function importPrivateKey(pem: string): Promise<CryptoKey> {
  const format = "pkcs8";
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem
      .substring(pemHeader.length, pem.length - pemFooter.length - 1)
      .replaceAll("\n", "") // Attempt to remove any abnormalities
      .replaceAll(" ", "");

  // base64 decode the string to get the binary data
  const binaryDerString: string = atob(pemContents);
  const keyData: ArrayBuffer = str2ab(binaryDerString);
  const extractable = false;
  return subtle.importKey(format, keyData, algorithm, extractable, keyUsages);
}

function str2ab(str: string): ArrayBuffer {
  const buf = new ArrayBuffer(str.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0, strLen = str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}
