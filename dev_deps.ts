import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.178.0/testing/asserts.ts";
export { assert, assertEquals, assertRejects };

export function assertHeader(headers: Headers, name: string, value?: string) {
  if (value !== undefined) {
    assertEquals(
      headers.get(name),
      value,
      `should have ${name} header of ${value} instead of ${headers.get(name)}`,
    );
  } else {
    assert(headers.get(name), `should have ${name} header`);
  }
}

export * as fc from "https://cdn.skypack.dev/fast-check@3.6.2";

export function mkBuffer(sizeInBytes: number): Uint8Array {
  const buffer = new Uint8Array(sizeInBytes);
  const chunkSize = 65536; // maximum chunk size allowed by crypto.getRandomValues()
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.subarray(i, i + chunkSize);
    crypto.getRandomValues(chunk); // fill the chunk with random values
  }
  return buffer;
}
