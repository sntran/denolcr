import { assert } from "../../dev_deps.ts";
import { fetch } from "./main.ts";

Deno.test("HEAD", () => {
  assert(fetch);

  // TODO: `HEAD source:`

  // TODO: `HEAD source:/path/to/folder`

  // TODO: `HEAD source:/path/to/file`

  // TODO: `HEAD source:?team_drive`

  // TODO: `HEAD source:?root_folder_id`
});
