import { base64url } from "../../deps.js";

import { reveal } from "../../cmd/obscure/main.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const CLIENT_ID = "202264815644.apps.googleusercontent.com";
const CLIENT_SECRET = await reveal(
  "eX8GpZTVx3vxMWVkuuBdDWmAUE6rGhTwVrvG9GhllYccSdj2-mvHVg",
).then((r) => r.text());
const SCOPE = "drive";

const encoder = new TextEncoder();

/**
 * @typedef {Object} Token
 * @property {string} access_token
 * @property {string} refresh_token
 * @property {string} expiry
 */

/**
 * @typedef {Object} ServiceAccount
 * @property {string} client_email
 * @property {string} private_key_id
 * @property {string} private_key
 */

/**
 * Authorizes a Request.
 *
 * The returned Request will have an Authorization header with a valid access token.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function auth(request) {
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

  /** @type {string[]} */
  const scopes = (searchParams.get("scope") || SCOPE)
    .split(",").map((scope) =>
      `https://www.googleapis.com/auth/${scope.trim()}`
    );

  let serviceAccountCredentials = searchParams.get(
    "service_account_credentials",
  );
  const serviceAccountFile = searchParams.get("service_account_file");
  if (serviceAccountFile) {
    const response = await fetch(serviceAccountFile);
    serviceAccountCredentials = await response.text();
  }

  if (serviceAccountCredentials) {
    /** @type {ServiceAccount} */
    const serviceAccount = JSON.parse(serviceAccountCredentials);
    /** @type {string} */
    const jwt = await createJWT(serviceAccount, scopes);
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
    body.set("assertion", jwt);
  } else {
    const client_id = searchParams.get("client_id") || CLIENT_ID;
    const client_secret = searchParams.get("client_secret") || CLIENT_SECRET;
    let token = searchParams.get("token") || "";
    try {
      // Refresh token can be passed inside a JSON (rclone style) or the token itself.
      const { refresh_token } = JSON.parse(token);
      token = refresh_token;
    } catch {
      // Do nothing.
    }

    body.set("grant_type", "refresh_token");
    body.set("client_id", client_id);
    body.set("client_secret", client_secret);
    body.set("refresh_token", token);
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

//#region JWT
const subtle = crypto.subtle;

const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
/** @type {KeyUsage[]} */
const keyUsages = ["sign"];

const header = btoa(JSON.stringify({
  alg: "RS256",
  typ: "JWT",
}));

/**
 * Generates a JWT for a Service Account with specified scopes.
 *
 * @param {ServiceAccount} serviceAccount
 * @param {string[]} scopes
 * @returns {Promise<string>}
 */
async function createJWT(serviceAccount, scopes) {
  const { client_email, private_key } = serviceAccount;

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: client_email,
    scope: scopes.join(" "),
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const jwt = `${header}.${btoa(JSON.stringify(payload))}`;
  /** @type {CryptoKey} */
  const key = await importPrivateKey(private_key);

  const signature = await subtle.sign(
    algorithm,
    key,
    encoder.encode(jwt),
  );
  const signatureEncoded = base64url.encode(new Uint8Array(signature));

  return `${jwt}.${signatureEncoded}`;
}

const PEM_HEADER = "-----BEGIN PRIVATE KEY-----";
const PEM_FOOTER = "-----END PRIVATE KEY-----";

/**
 * Imports a PEM encoded private key.
 * @param {string} pem
 * @returns {Promise<CryptoKey>}
 */
function importPrivateKey(pem) {
  const format = "pkcs8";
  const pemContents = pem
    .substring(PEM_HEADER.length, pem.length - PEM_FOOTER.length - 1)
    .replaceAll(/\n|\s/g, "");

  // base64 decode the string to get the binary data
  const binaryDerString = atob(pemContents);
  const keyData = Uint8Array.from(binaryDerString, (x) => x.charCodeAt(0));
  const extractable = false;
  return subtle.importKey(format, keyData, algorithm, extractable, keyUsages);
}
//#endregion JWT
