import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "https://deno.land/std@0.203.0/assert/mod.ts";
export { assert, assertEquals, assertNotEquals, assertRejects };

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

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  // Should not happen
  if (a.length !== b.length) return false;
  let isSame = true;
  for (let i = 0; i < a.length; i++) isSame &&= a[i] === b[i]; // Lets hope JIT won't optimize away.
  return isSame;
}

export * as fc from "npm:fast-check@3.13.1";
