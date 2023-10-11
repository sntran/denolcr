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

export * as fc from "npm:fast-check@3.13.1";
