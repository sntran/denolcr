import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serve } from "./main.js";

test("a client of serve cannot set an option of the remote", async () => {
  const inside = await mkdtemp(join(tmpdir(), "rfetch-serve-inside-"));
  const outside = await mkdtemp(join(tmpdir(), "rfetch-serve-outside-"));
  await writeFile(join(inside, "a.txt"), "inside");
  await writeFile(join(outside, "a.txt"), "outside");
  const response = await serve("http", `:alias,remote='${inside}/':`, {
    addr: "127.0.0.1:0",
  });
  const reader = response.body.getReader();
  try {
    const { value } = await reader.read();
    const [url] = new TextDecoder().decode(value).match(/http:\/\/\S+/);
    const get = async (path, headers = {}) => {
      const answer = await fetch(new URL(path, url), { headers });
      return answer.ok ? await answer.text() : answer.status;
    };

    assert.equal(await get("/a.txt"), "inside");
    // The query of the client is not an option.
    assert.equal(
      await get(`/a.txt?remote=${encodeURIComponent(`${outside}/`)}`),
      "inside",
    );
    // A header of the client is not an option, and tells no remote.
    assert.equal(
      await get("/a.txt", {
        RFETCH_ALIAS_REMOTE: `${outside}/`,
        RCLONE_ALIAS_REMOTE: `${outside}/`,
      }),
      "inside",
    );
  } finally {
    await reader.cancel();
    await rm(inside, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
