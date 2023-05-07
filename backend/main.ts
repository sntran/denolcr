/**
 * A backend is an interface to remote storage provider.
 *
 * Each backend implements the `fetch` method which takes a request and returns
 * a response, or a promise of a response.
 */

// This is *not* an IIFE, it's just a function expression that never gets run.
// The static analysis will detect these imports and load them at the beginning
// of the program, just like for static imports.
(() => {
  import("./alias/main.ts");
  import("./chunker/main.ts");
  import("./crypt/main.ts");
  import("./drive/main.ts");
  import("./fshare/main.ts");
  import("./local/main.ts");
  import("./memory/main.ts");
});

export interface Backend {
  fetch(request: Request): Response | Promise<Response>;
}

const backends: Record<string, () => Promise<Backend>> = {
  alias: () => import("./alias/main.ts"),
  chunker: () => import("./chunker/main.ts"),
  crypt: () => import("./crypt/main.ts"),
  drive: () => import("./drive/main.ts"),
  fshare: () => import("./fshare/main.ts"),
  local: () => import("./local/main.ts"),
  memory: () => import("./memory/main.ts"),
}

/**
 * Dynamically imports a backend based on the type.
 *
 * The backend modules should already be loaded by the static analysis.
 */
export default function(type: string): Promise<Backend> {
  const backendFactory = backends[type];
  if (backendFactory) {
    return backendFactory();
  }

  return import(type);
}
