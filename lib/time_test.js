import { test } from "node:test";
import assert from "node:assert/strict";

import { toLocaleISOString } from "./time.js";

test("toLocaleISOString writes the times of rclone lsjson", () => {
  const time = "2026-10-17T03:56:05.819Z";
  for (
    const [offset, expected] of [
      [0, "2026-10-17T03:56:05.819Z"],
      [60, "2026-10-17T04:56:05.819+01:00"],
      [-300, "2026-10-16T22:56:05.819-05:00"],
      [330, "2026-10-17T09:26:05.819+05:30"],
      [-570, "2026-10-16T18:26:05.819-09:30"],
      [840, "2026-10-17T17:56:05.819+14:00"],
    ]
  ) {
    assert.equal(toLocaleISOString(time, offset), expected, `${offset}`);
  }
  // The milliseconds stay, also when they are zero.
  assert.equal(
    toLocaleISOString("2026-10-17T03:56:05Z", 0),
    "2026-10-17T03:56:05.000Z",
  );
  for (const value of [null, undefined, "", "not a time"]) {
    assert.equal(toLocaleISOString(value), undefined);
  }
});
