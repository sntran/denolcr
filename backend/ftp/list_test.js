/**
 * The tests of the lists of FTP, with no server: MLSD, the times of MDTM,
 * and LIST of Unix and of MS-DOS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { parseLIST, parseMLSD, parseTime } from "./list.js";

test("parseMLSD reads the facts of RFC 3659", () => {
  for (
    const [line, expected] of [
      [
        "type=file;size=3;modify=20121127181505; a.txt",
        {
          name: "a.txt",
          type: "file",
          size: 3,
          modTime: "2012-11-27T18:15:05Z",
        },
      ],
      [
        "Type=dir;Modify=20121127181505.123;Perm=el; my folder",
        {
          name: "my folder",
          type: "dir",
          size: -1,
          modTime: "2012-11-27T18:15:05Z",
        },
      ],
      [
        "type=OS.unix=slink:/a/b;size=4; link",
        { name: "link", type: "link", size: 4, modTime: "" },
      ],
      [
        // MLST gives a space before the facts.
        " type=file;sizd=10; name with  two spaces ",
        { name: "name with  two spaces ", type: "file", size: 10, modTime: "" },
      ],
      ["type=file; ;x", { name: ";x", type: "file", size: -1, modTime: "" }],
      ["type=cdir; .", null],
      ["type=pdir; ..", null],
      ["type=file; ..", null],
      ["type=OS.unix=chr-13/29; tty", null],
      ["no-space", null],
    ]
  ) {
    assert.deepEqual(parseMLSD(line), expected, line);
  }
});

test("parseTime reads the times of MLSD and MDTM, to the second", () => {
  assert.equal(parseTime("20121127181505"), "2012-11-27T18:15:05Z");
  assert.equal(parseTime("20121127181505.999"), "2012-11-27T18:15:05Z");
  assert.equal(parseTime("19700101000000"), "1970-01-01T00:00:00Z");
  for (const text of ["", "2012112718150", "2012-11-27", "20121127181505Z"]) {
    assert.equal(parseTime(text), "", text);
  }
  fc.assert(
    fc.property(
      fc.date({
        min: new Date("1000-01-01T00:00:00Z"),
        max: new Date("9999-12-31T23:59:59Z"),
        noInvalidDate: true,
      }),
      (date) => {
        const second = new Date(Math.floor(date.getTime() / 1000) * 1000);
        const text = second.toISOString().slice(0, 19).replace(/\D/g, "");
        assert.equal(
          parseTime(text),
          second.toISOString().replace(".000Z", "Z"),
        );
      },
    ),
  );
});

test("parseLIST reads the lines of ls -l and of MS-DOS", () => {
  for (
    const [line, expected] of [
      [
        "-rw-r--r--    1 user     group         1024 Nov 27 18:15 a b.txt",
        { name: "a b.txt", type: "file", size: 1024, modTime: "" },
      ],
      [
        "drwxr-xr-x    2 user     group         4096 Jan  2  2020 folder",
        { name: "folder", type: "dir", size: -1, modTime: "" },
      ],
      [
        "lrwxrwxrwx    1 user     group            7 Jan  2  2020 link -> a b.txt",
        {
          name: "link",
          type: "link",
          size: 7,
          modTime: "",
          target: "a b.txt",
        },
      ],
      [
        // No group, as some servers.
        "-rw-r--r-- 1 owner 5 Mar  3 09:07  leading space",
        { name: " leading space", type: "file", size: 5, modTime: "" },
      ],
      [
        "-rw-r--r--+   1 user group 12 Dec 31 23:59 acl.txt",
        { name: "acl.txt", type: "file", size: 12, modTime: "" },
      ],
      [
        "01-02-23  03:04PM       <DIR>          My Folder",
        { name: "My Folder", type: "dir", size: -1, modTime: "" },
      ],
      [
        "01-02-2023  03:04       1234 file.bin",
        { name: "file.bin", type: "file", size: 1234, modTime: "" },
      ],
      ["drwxr-xr-x 2 user group 4096 Jan  2  2020 .", null],
      ["drwxr-xr-x 2 user group 4096 Jan  2  2020 ..", null],
      ["crw-rw-rw- 1 root root 1, 3 Jan  2  2020 null", null],
      ["total 12", null],
      ["", null],
    ]
  ) {
    assert.deepEqual(parseLIST(line), expected, line);
  }
});

test("parseLIST keeps each name of ls -l", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }).filter((name) =>
        !/[\r\n]/.test(name) && name !== "." && name !== ".." &&
        !name.includes(" -> ")
      ),
      fc.nat(),
      (name, size) => {
        const line =
          `-rw-r--r--    1 user     group  ${size} Nov 27 18:15 ${name}`;
        assert.deepEqual(parseLIST(line), {
          name,
          type: "file",
          size,
          modTime: "",
        });
      },
    ),
  );
});
