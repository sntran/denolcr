import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import fc from "fast-check";

import { parseList } from "./list.js";

test("parseList reads the values of a list", () => {
  for (
    const [text, values] of [
      ["", []],
      ["a", ["a"]],
      ["a,b", ["a", "b"]],
      ["a,", ["a", ""]],
      [",", ["", ""]],
      [" a , b ", [" a ", " b "]],
      ['"a,b",c', ["a,b", "c"]],
      ['"a ""b"" c"', ['a "b" c']],
      ['""', [""]],
      ['"a\nb",c', ["a\nb", "c"]],
      ['"a\r\nb"', ["a\nb"]],
      ["a,b\nc,d", ["a", "b"]],
      ["\n\na,b", ["a", "b"]],
      ["a\r\n", ["a"]],
      ["a\r", ["a"]],
      ["a\rb", ["a\rb"]],
      ['Cookie,"a=1, b=2"', ["Cookie", "a=1, b=2"]],
    ]
  ) {
    assert.deepEqual(parseList(text), values, JSON.stringify(text));
  }
  assert.deepEqual(parseList('a "b c" d', " "), ["a", "b c", "d"]);
  for (const text of ['a"b', 'a,b"', '"a"b', '"a', "\n", "\r", '"a\n']) {
    assert.throws(() => parseList(text), SyntaxError, JSON.stringify(text));
  }
});

const GO = process.env.GO || "go";
const hasGo = spawnSync(GO, ["version"]).status === 0;

/** The code of `genericList.set` of rclone, for each text of the input. */
const PROGRAM = `package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"os"
)

type input struct {
	Text      string
	Separator rune
}

type output struct {
	Values []string
	Error  bool
}

func set(sep rune, b []byte) ([]string, error) {
	if len(b) == 0 {
		return []string{}, nil
	}
	r := csv.NewReader(bytes.NewReader(b))
	r.Comma = sep
	return r.Read()
}

func main() {
	var inputs []input
	if err := json.NewDecoder(os.Stdin).Decode(&inputs); err != nil {
		panic(err)
	}
	outputs := make([]output, len(inputs))
	for i, in := range inputs {
		values, err := set(in.Separator, []byte(in.Text))
		outputs[i] = output{Values: values, Error: err != nil}
	}
	json.NewEncoder(os.Stdout).Encode(outputs)
}
`;

describe("parseList and encoding/csv of Go", {
  skip: !hasGo && "Go is not installed. Set GO to its path.",
}, () => {
  test("give the same values and the same errors", () => {
    const inputs = fc.sample(
      fc.record({
        Text: fc.stringOf(
          fc.constantFrom("a", "b", " ", ",", '"', "\n", "\r", "é"),
          { maxLength: 12 },
        ),
        Separator: fc.constantFrom(",", " "),
      }),
      { numRuns: 5000, seed: 42 },
    );

    const folder = mkdtempSync(join(tmpdir(), "rfetch-list-"));
    try {
      writeFileSync(join(folder, "main.go"), PROGRAM);
      const { status, stdout, stderr } = spawnSync(
        GO,
        ["run", join(folder, "main.go")],
        {
          input: JSON.stringify(
            inputs.map(({ Text, Separator }) => ({
              Text,
              Separator: Separator.codePointAt(0),
            })),
          ),
        },
      );
      assert.equal(status, 0, `${stderr}`);
      const outputs = JSON.parse(stdout);
      for (const [index, { Text, Separator }] of inputs.entries()) {
        const { Values, Error } = outputs[index];
        const what = `${JSON.stringify(Text)} with ${
          JSON.stringify(Separator)
        }`;
        if (Error) {
          assert.throws(() => parseList(Text, Separator), SyntaxError, what);
        } else {
          assert.deepEqual(parseList(Text, Separator), Values, what);
        }
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
