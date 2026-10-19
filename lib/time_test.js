import { test } from "node:test";
import assert from "node:assert/strict";

import { nanosecondsOf, toListTime, toLocaleISOString } from "./time.js";

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
  // A time to the second stays a time to the second, as the precision of the
  // remote, for example http.
  assert.equal(
    toLocaleISOString("2026-10-17T03:56:05Z", 0),
    "2026-10-17T03:56:05Z",
  );
  assert.equal(
    toLocaleISOString("2026-10-17T03:56:05Z", 90),
    "2026-10-17T05:26:05+01:30",
  );
  // The milliseconds of a Date stay, also when they are zero.
  assert.equal(
    toLocaleISOString(new Date("2026-10-17T03:56:05Z"), 0),
    "2026-10-17T03:56:05.000Z",
  );
  for (const value of [null, undefined, "", "not a time"]) {
    assert.equal(toLocaleISOString(value), undefined);
  }
});

test("toLocaleISOString keeps the digits of the time, from 0 to 9", () => {
  for (
    const [time, offset, expected] of [
      ["2026-10-18T15:02:41.540476887Z", 0, "2026-10-18T15:02:41.540476887Z"],
      [
        "2026-10-18T15:02:41.540476887Z",
        420,
        "2026-10-18T22:02:41.540476887+07:00",
      ],
      [
        "2026-10-18T00:02:41.000000001+00:00",
        -300,
        "2026-10-17T19:02:41.000000001-05:00",
      ],
      ["2026-10-18T15:02:41.540476Z", 0, "2026-10-18T15:02:41.540476Z"],
      ["2026-10-18T15:02:41.1234567891Z", 0, "2026-10-18T15:02:41.123456789Z"],
      ["2026-10-18T15:02:41.5Z", 0, "2026-10-18T15:02:41.5Z"],
      ["2026-10-18T15:02:41.540Z", 0, "2026-10-18T15:02:41.540Z"],
    ]
  ) {
    assert.equal(toLocaleISOString(time, offset), expected, time);
  }
});

test("toListTime writes the times of the lists of rclone", () => {
  const offset = new Date("2026-10-18T15:02:41Z").getTimezoneOffset();
  // The local time zone of the tests is not known: the test makes the
  // expected time in it.
  const local = new Date(Date.parse("2026-10-18T15:02:41Z") - offset * 60000)
    .toISOString().slice(0, 19).replace("T", " ");
  assert.equal(toListTime("2026-10-18T15:02:41.540476887Z"), local);
  assert.equal(
    toListTime("2026-10-18T15:02:41.540476887Z", 9),
    `${local}.540476887`,
  );
  assert.equal(toListTime("2026-10-18T15:02:41.5Z", 9), `${local}.500000000`);
  assert.equal(toListTime("2026-10-18T15:02:41Z", 9), `${local}.000000000`);
  assert.equal(toListTime(""), "0001-01-01 00:00:00");
  assert.equal(toListTime(undefined, 9), "0001-01-01 00:00:00.000000000");
});

test("nanosecondsOf keeps all the digits of a time", () => {
  assert.equal(
    nanosecondsOf("2026-10-19T01:00:00.123456789Z"),
    1792371600123456789n,
  );
  assert.equal(
    nanosecondsOf("2026-10-19T03:00:00.1+02:00"),
    1792371600100000000n,
  );
  assert.equal(nanosecondsOf("2026-10-19T01:00:00Z"), 1792371600000000000n);
  assert.equal(
    nanosecondsOf("Mon, 19 Oct 2026 01:00:00 GMT"),
    1792371600000000000n,
  );
  for (const value of [undefined, null, "", "not a time"]) {
    assert.equal(nanosecondsOf(value), undefined, `${value}`);
  }
});
