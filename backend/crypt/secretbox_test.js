import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { DecryptionStream, EncryptionStream } from "./secretbox.js";

test("decrypt/crypt", () => {
  fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.uint8Array({ maxLength: 8 }),
      fc.uint8Array(),
      async (key, magic, content) => {
        const decryptionStream = ReadableStream.from([content])
          .pipeThrough(new EncryptionStream(key, { magic }))
          .pipeThrough(new DecryptionStream(key, { magic }));

        const result = new Uint8Array(
          await new Response(decryptionStream).arrayBuffer(),
        );
        assert.deepEqual(result, content);
      },
    ),
  );
});
