import { defineConfig } from "tsup"

/**
 * provider-core is source-first for the host: its `exports` map resolves to
 * `src/` and the app compiles it as part of its own graph. That is deliberate
 * and is left alone.
 *
 * This build exists for a second consumer — plugin authors. The plugin SDK's
 * public `.d.ts` reaches into `@cognia/provider-core/core/client`, so a
 * scaffolded plugin project cannot type-check unless those declarations exist
 * somewhere resolvable. `scripts/plugin/generate-author-types.mjs` reads the
 * `dist/` this produces and vendors it into the CLI.
 *
 * The package already has zero `@/` imports, so no alias plugin is needed.
 * Entry mirrors provider-types: every module, not just the barrel, so subpath
 * imports (`/core/client`, `/providers/*`) resolve from dist too.
 */
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["zod", "ai", /^@ai-sdk\//, /^@cognia\/provider-/],
})
