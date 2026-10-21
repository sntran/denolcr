import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { isOption, optionsOf, remoteHeaders } from "./options.js";

test("optionsOf takes the query, then the headers, then env", () => {
  const request = new Request("https://rfetch.test/a?remote=query", {
    headers: {
      RCLONE_CRYPT_REMOTE: "header",
      RCLONE_CRYPT_PASSWORD: "from-header",
      RCLONE_S3_ENDPOINT: "not-for-crypt",
    },
  });
  const options = optionsOf(request, "crypt", {
    RCLONE_CRYPT_REMOTE: "env",
    RCLONE_CRYPT_PASSWORD: "env",
    RCLONE_CRYPT_PASSWORD2: "from-env",
    RCLONE_CRYPT_NUMBER: 1,
  });
  assert.equal(options.get("remote"), "query");
  assert.equal(options.get("password"), "from-header");
  assert.equal(options.get("password2"), "from-env");
  assert.equal(options.get("endpoint"), null);
  // A value of env that is not a text, for example a binding, is not an
  // option.
  assert.equal(options.get("number"), null);
});

test("optionsOf takes RFETCH_ in the place of RCLONE_", () => {
  const request = new Request("https://rfetch.test/", {
    headers: {
      RCLONE_S3_REGION: "rclone-header",
      RFETCH_S3_REGION: "rfetch-header",
      RCLONE_S3_ENDPOINT: "rclone-header",
    },
  });
  const options = optionsOf(request, "s3", {
    RCLONE_S3_ENDPOINT: "rclone-env",
    RCLONE_S3_PROVIDER: "rclone-env",
    RFETCH_S3_PROVIDER: "rfetch-env",
  });
  assert.equal(options.get("region"), "rfetch-header");
  // A header takes the place of a variable of env, of each prefix.
  assert.equal(options.get("endpoint"), "rclone-header");
  assert.equal(options.get("provider"), "rfetch-env");
});

test("optionsOf takes no option from a header with an empty value", () => {
  const request = new Request("https://rfetch.test/", {
    headers: {
      RFETCH_S3_REGION: "",
      RCLONE_S3_REGION: "rclone-header",
      RFETCH_S3_ENDPOINT: "",
      RFETCH_S3_PROVIDER: "",
    },
  });
  const options = optionsOf(request, "s3", {
    RFETCH_S3_ENDPOINT: "env",
  });
  // The next place gives the value: a header of the other prefix, or env.
  assert.equal(options.get("region"), "rclone-header");
  assert.equal(options.get("endpoint"), "env");
  // With no other place, the option is not set, and the default stays.
  assert.equal(options.has("provider"), false);
});

test("optionsOf reads the names of headers in each case", () => {
  for (
    const name of ["RCLONE_S3_REGION", "rclone_s3_region", "Rclone_S3_Region"]
  ) {
    const request = new Request("https://rfetch.test/", {
      headers: { [name]: "auto" },
    });
    assert.equal(optionsOf(request, "s3").get("region"), "auto", name);
  }
});

test("optionsOf keeps an option of env with characters of each language", () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme" }), (value) => {
      const request = new Request("https://rfetch.test/");
      const options = optionsOf(request, "alias", {
        RCLONE_ALIAS_REMOTE: value,
      });
      assert.equal(options.get("remote"), value);
    }),
  );
});

test("optionsOf does not change the query of the request", () => {
  const request = new Request("https://rfetch.test/?a=1", {
    headers: { RCLONE_ALIAS_REMOTE: "header" },
  });
  optionsOf(request, "alias");
  assert.equal(new URL(request.url).search, "?a=1");
});

test("isOption tells the headers of rfetch and of rclone", () => {
  assert.ok(isOption("RFETCH_CONFIG_R2_TYPE"));
  assert.ok(isOption("RCLONE_CONFIG_R2_TYPE"));
  assert.ok(isOption("rclone_s3_access_key_id"));
  assert.ok(!isOption("Range"));
  assert.ok(!isOption("X-Rclone"));
});

test("remoteHeaders keeps the other options for a remote of rfetch", () => {
  const headers = remoteHeaders(
    {
      Range: "bytes=0-1",
      RCLONE_CRYPT_PASSWORD: "secret",
      RFETCH_CRYPT_PASSWORD2: "secret",
      RCLONE_CONFIG_R2_TYPE: "s3",
      RFETCH_S3_REGION: "auto",
    },
    "crypt",
    "r2:bucket",
  );
  assert.deepEqual([...headers].sort(), [
    ["range", "bytes=0-1"],
    ["rclone_config_r2_type", "s3"],
    ["rfetch_s3_region", "auto"],
  ]);
});

test("remoteHeaders gives no option to a URL", () => {
  for (
    const remote of [
      "https://example.com/a",
      "http://127.0.0.1:1",
      "file:///tmp",
    ]
  ) {
    const headers = remoteHeaders(
      {
        Range: "bytes=0-1",
        RCLONE_CRYPT_PASSWORD: "secret",
        RFETCH_CRYPT_PASSWORD: "secret",
        RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: "secret",
        RFETCH_CONFIG_R2_SECRET_ACCESS_KEY: "secret",
      },
      "crypt",
      remote,
    );
    assert.deepEqual([...headers], [["range", "bytes=0-1"]], remote);
  }
});
