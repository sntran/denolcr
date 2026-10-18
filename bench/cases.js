/**
 * The cases of the benchmark of rfetch. They use no API of Node.js only,
 * thus they run in Node.js (`bench/node.js`) and in a Worker
 * (`bench/worker.js`).
 */
// The import also sets the global `fetch`, which reads the paths of remotes.
import { fetch, lsjson } from "../mod.js";
import { readListing, renderListing } from "@rfetch/lib/listing";
import memory from "@rfetch/memory";
import { childrenOf, parseXML, textOf } from "../backend/s3/xml.js";
import { sign, UNSIGNED_PAYLOAD } from "../backend/s3/sigv4.js";

/** The size of a large file. */
export const SIZE = 8 * 1024 * 1024;
/** The number of files in a list. */
const FILES = 1000;

/** "test-password", obscured by rclone. */
const PASSWORD = "4OSlj-ZYMGdEIGjcWg_gc-DL4O3TFAvr4ct_yV4";
const CRYPT = {
  RFETCH_CRYPT_REMOTE: ":memory:/bench-crypt",
  RFETCH_CRYPT_PASSWORD: PASSWORD,
};
const CRYPT_LIST = {
  ...CRYPT,
  RFETCH_CRYPT_REMOTE: ":memory:/bench-crypt-list",
};
const CHUNKER = {
  RFETCH_CHUNKER_REMOTE: ":memory:/bench-chunker",
  RFETCH_CHUNKER_CHUNK_SIZE: "1M",
};

/** Bytes that do not compress, with no cost of a random source. */
function data(size) {
  const bytes = new Uint8Array(size);
  let x = 0x9e3779b9;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x;
  }
  return bytes;
}

// The data of the cases. `setup` makes them: a Worker cannot do such work
// at the start of the module.
let big = new Uint8Array(0);
let small = new Uint8Array(0);
let html = "";
let xml = "";

/** @param {Response} response */
async function drain(response) {
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  await response.arrayBuffer();
}

/** @param {string} location @param {Uint8Array} body @param {HeadersInit} [headers] */
async function put(location, body, headers = {}) {
  await drain(await fetch(location, { method: "PUT", body, headers }));
}

/** @param {string} location @param {HeadersInit} [headers] */
async function get(location, headers = {}) {
  await drain(await fetch(location, { headers }));
}

/** The entries of a list of `count` files. */
function entries(count) {
  return Array.from({ length: count }, (_, i) => ({
    Name: `file ${i} é.txt`,
    IsDir: false,
    Size: i * 100,
    MimeType: "text/plain; charset=utf-8",
    ModTime: new Date(1700000000000 + i * 1000).toISOString(),
  }));
}

/** The answer of ListObjectsV2 of S3 for `count` keys. */
function listXML(count) {
  const contents = Array.from(
    { length: count },
    (_, i) =>
      `<Contents><Key>folder/file%20${i}.txt</Key>` +
      `<LastModified>2026-10-18T12:00:00.000Z</LastModified>` +
      `<ETag>&quot;0123456789abcdef&quot;</ETag><Size>${i}</Size>` +
      `<StorageClass>STANDARD</StorageClass></Contents>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
    `<Name>bucket</Name><Prefix>folder/</Prefix><KeyCount>${count}</KeyCount>` +
    `<MaxKeys>1000</MaxKeys><EncodingType>url</EncodingType>` +
    `<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
}

/** Makes the data, and puts the files that the cases read. */
export async function setup() {
  big = data(SIZE);
  small = data(100);
  html = await new Response(renderListing(entries(10 * FILES))).text();
  xml = listXML(FILES);
  await put(":memory:/bench/big.bin", big);
  await put(":crypt:big.bin", big, CRYPT);
  await put(":chunker:big.bin", big, CHUNKER);
  await put(":memory:/bench/small.txt", small);
  for (let i = 0; i < FILES; i++) {
    await put(`:memory:/bench-list/file${i}.txt`, small);
    await put(`:crypt:file${i}.txt`, small, CRYPT_LIST);
  }
}

/** @type {Record<string, () => Promise<void>>} */
export const cases = {
  "memory: PUT 8 MiB": () => put(":memory:/bench/put.bin", big),
  "memory: GET 8 MiB": () => get(":memory:/bench/big.bin"),
  "crypt: PUT 8 MiB": () => put(":crypt:put.bin", big, CRYPT),
  "crypt: GET 8 MiB": () => get(":crypt:big.bin", CRYPT),
  "crypt: GET a range of 1 MiB": () =>
    get(":crypt:big.bin", { ...CRYPT, Range: "bytes=3000000-4048575" }),
  "chunker: PUT 8 MiB in chunks of 1 MiB": () =>
    put(":chunker:put.bin", big, CHUNKER),
  "chunker: GET 8 MiB in chunks of 1 MiB": () =>
    get(":chunker:big.bin", CHUNKER),
  "memory: list 1000 files": () => get(":memory:/bench-list/"),
  "crypt: list 1000 files": () => get(":crypt:", CRYPT_LIST),
  "crypt: lsjson of 1000 files": async () => {
    await drain(await lsjson(":crypt:", {}, { headers: CRYPT_LIST }));
  },
  "lib: renderListing of 10000 entries": async () => {
    await new Response(renderListing(entries(10 * FILES))).arrayBuffer();
  },
  "lib: readListing of 10000 entries": async () => {
    await readListing(new Response(html), new URL("http://bench/folder/"));
  },
  "s3: sign 1000 requests": async () => {
    const credentials = {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "auto",
    };
    for (let i = 0; i < FILES; i++) {
      sign({
        method: "GET",
        url: new URL(`https://bucket.example.com/folder/file%20${i}.txt`),
        headers: new Headers({ Range: "bytes=0-99" }),
        payload: UNSIGNED_PAYLOAD,
      }, credentials);
    }
  },
  "s3: read a list of 1000 keys": async () => {
    const root = parseXML(xml);
    for (const object of childrenOf(root, "Contents")) {
      decodeURIComponent(textOf(object, "Key").replaceAll("+", " "));
      Number(textOf(object, "Size"));
    }
  },
  "rfetch fetch: 1000 GET of a small file": async () => {
    for (let i = 0; i < FILES; i++) await get(":memory:/bench/small.txt");
  },
  "memory, no rfetch fetch: 1000 GET of a small file": async () => {
    for (let i = 0; i < FILES; i++) {
      await drain(
        await memory.fetch(new Request("http://bench/bench/small.txt")),
      );
    }
  },
};
