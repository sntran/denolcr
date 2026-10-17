import { test } from "node:test";
import assert from "node:assert/strict";

import { sign, uriEncode } from "./sigv4.js";

/**
 * The examples of "Signature Calculations for the Authorization Header" in
 * the documentation of Amazon S3: the key, the date, and the signatures.
 */
const CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};
const NOW = new Date("2013-05-24T00:00:00Z");

/** @param {Headers} headers */
function signatureOf(headers) {
  return headers.get("Authorization").match(/Signature=([0-9a-f]+)$/)[1];
}

test("signs the GET of an object with a range", () => {
  const headers = sign(
    {
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: new Headers({ Range: "bytes=0-9" }),
    },
    CREDENTIALS,
    NOW,
  );
  assert.equal(
    headers.get("Authorization"),
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("signs the PUT of an object", () => {
  const headers = sign(
    {
      method: "PUT",
      url: new URL(
        `https://examplebucket.s3.amazonaws.com/${
          uriEncode("test$file.text", true)
        }`,
      ),
      headers: new Headers({
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      }),
      payload:
        "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    },
    CREDENTIALS,
    NOW,
  );
  assert.equal(
    signatureOf(headers),
    "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
  );
});

test("signs a list with a query", () => {
  const headers = sign(
    {
      method: "GET",
      url: new URL(
        "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
      ),
      headers: new Headers(),
    },
    CREDENTIALS,
    NOW,
  );
  assert.equal(
    signatureOf(headers),
    "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
  );
});

test("signs a query with a name and no value", () => {
  const headers = sign(
    {
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?lifecycle"),
      headers: new Headers(),
    },
    CREDENTIALS,
    NOW,
  );
  assert.equal(
    signatureOf(headers),
    "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
  );
});

test("uriEncode keeps only the bytes that AWS keeps", () => {
  assert.equal(uriEncode("a-z_A.Z~0 9"), "a-z_A.Z~0%209");
  assert.equal(uriEncode("!'()*"), "%21%27%28%29%2A");
  assert.equal(uriEncode("a/b c", true), "a/b%20c");
  assert.equal(uriEncode("a/b"), "a%2Fb");
  assert.equal(uriEncode("é+&="), "%C3%A9%2B%26%3D");
});
