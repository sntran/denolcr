import { assert } from "../../dev_deps.js";
import backend from "./main.js";

Deno.test("HEAD", () => {
  assert(backend.fetch);

  // TODO: `HEAD source:`

  // TODO: `HEAD source:/path/to/folder`

  // TODO: `HEAD source:/path/to/file`

  // TODO: `HEAD source:?team_drive`

  // TODO: `HEAD source:?root_folder_id`
});
