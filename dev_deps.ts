import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.177.0/testing/asserts.ts";
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
