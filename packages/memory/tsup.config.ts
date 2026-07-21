import { defineConfig } from "tsup"

// @cognia/memory is a truly-standalone core: after extraction it has ZERO `@/`
// app imports (the DB/LLM/settings couplings stay app-side and are passed in via
// the existing deps interfaces). The only externals are peer libs (`ai`, `zod`)
// and the sibling `@cognia/*` packages. A green build here is the invariant that
// guards against a future `@/` leak sneaking back in.
export default defineConfig({
  // Build every module (not just the barrel) so subpath imports
  // (`@cognia/memory/retrieve/retriever`, …) resolve from dist too and the whole
  // package is validated as standalone-compilable.
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2017",
  external: ["ai", "zod", /^@cognia\//],
})
