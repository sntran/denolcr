import { base64url } from "../../deps.ts";

import { reveal } from "rclone/cmd/obscure/main.ts";

const TOKEN_URL = "https://www.googleapis.com/oauth2/v4/token";

const CLIENT_ID = "202264815644.apps.googleusercontent.com";
const CLIENT_SECRET = await reveal(
  "eX8GpZTVx3vxMWVkuuBdDWmAUE6rGhTwVrvG9GhllYccSdj2-mvHVg",
).then((r) => r.text());
const SCOPE = "drive";

const encoder = new TextEncoder();

export type Token = {
  access_token: string;
  refresh_token: string;
  expiry: string;
};

export type ServiceAccount = {
  client_email: string;
  private_key_id: string;
  private_key: string;
}

/**
 * Authorizes a Request.
 *
 * The returned Request will have an Authorization header with a valid access token.
 */
export async function auth(request: Request): Promise<Response> {
  const { headers, url } = request;
  const authorization = headers.get("Authorization");
  if (authorization) {
    const [token_type, access_token] = authorization.split(" ");
    return Response.json({
      token_type,
      access_token,
    });
  }

  const body = new URLSearchParams();
  const { searchParams } = new URL(url);

  const scopes: string[] = (searchParams.get("scope") || SCOPE)
    .split(",").map(scope => `https://www.googleapis.com/auth/${scope.trim()}`);

  let serviceAccountCredentials = searchParams.get("service_account_credentials");
  const serviceAccountFile = searchParams.get("service_account_file");
  if (serviceAccountFile) {
    serviceAccountCredentials = await fetch(serviceAccountFile).then(res => res.text());
  }

  if (serviceAccountCredentials) {
    const serviceAccount: ServiceAccount = JSON.parse(serviceAccountCredentials);;
    const jwt: string = await createJWT(serviceAccount, scopes);
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
    body.set("assertion", jwt);
  } else {
    const client_id = searchParams.get("client_id") || CLIENT_ID;
    const client_secret = searchParams.get("client_secret") || CLIENT_SECRET;
    const { refresh_token }: Token = JSON.parse(
      searchParams.get("token") || "{}",
    );
    body.set("grant_type", "refresh_token");
    body.set("client_id", client_id);
    body.set("client_secret", client_secret);
    body.set("refresh_token", refresh_token);
  }

  const tokenURL = searchParams.get("token_url") || TOKEN_URL;

  const response = await fetch(tokenURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const {
    error,
    error_description,
    access_token,
    expires_in,
    scope,
    token_type,
  } = await response.json();

  if (error) {
    return Response.json({
      error,
      error_description,
    }, {
      status: 401,
    });
  }

  if (expires_in <= 0) {
    // @TODO: refresh token
    return new Response();
  }

  return Response.json({
    token_type,
    access_token,
    scope,
    expires_in,
  });
}

const subtle = crypto.subtle;

const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const keyUsages: KeyUsage[] = ["sign"];

const header = btoa(JSON.stringify({
  alg: "RS256",
  typ: "JWT"
}));

/**
 * Generates a JWT for a Service Account with specified scopes.
 */
async function createJWT(serviceAccount: ServiceAccount, scopes: string[]): Promise<string> {
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