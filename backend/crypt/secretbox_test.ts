import { assertEquals, fc } from "../../dev_deps.ts";

import { DecryptionStream, EncryptionStream } from "./secretbox.js";

Deno.test("decrypt/crypt", () => {
  fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.uint8Array({ maxLength: 8 }),
      fc.uint8Array(),
      async (key: Uint8Array, magic: Uint8Array, content: Uint8Array) => {
        const decryptionStream = ReadableStream.from([content])
          .pipeThrough(new EncryptionStream(key, { magic }))
          .pipeThrough(new DecryptionStream(key, { magic }));

        const result = new Uint8Array(
          await new Response(decryptionStream).arrayBuffer(),
        );
        assertEquals(result, content);
      },
    ),
  );
});
