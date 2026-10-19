import { test } from "node:test";
import assert from "node:assert/strict";

import { parseHeaders } from "./headers.js";

test("parseHeaders reads the names and the values, as rclone", () => {
  const headers = parseHeaders(
    'Cookie,name=value,"Authorization","Basic a2V5",X-A,"a, b"',
  );
  assert.deepEqual([...headers], [
    ["authorization", "Basic a2V5"],
    ["cookie", "name=value"],
    ["x-a", "a, b"],
  ]);
  assert.deepEqual([...parseHeaders("")], []);
});

test("parseHeaders refuses an odd list and a bad name", () => {
  assert.throws(() => parseHeaders("Cookie"), {
    name: "SyntaxError",
    message: "odd number of headers supplied",
  });
  assert.throws(() => parseHeaders("bad name,value"), TypeError);
});
