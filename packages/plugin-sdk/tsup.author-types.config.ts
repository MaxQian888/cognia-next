import { defineConfig } from "tsup"

/**
 * A second, author-facing declaration build.
 *
 * The published `dist/*.d.ts` (see `tsup.config.ts`) keeps `@cognia/provider-*`
 * as bare imports, which is correct for a registry install where those packages
 * resolve as real dependencies. Plugin authors have no such registry: none of
 * the `@cognia/*` packages are published, so a scaffolded project cannot resolve
 * them and the template deliberately forbids `skipLibCheck`.
 *
 * This build therefore inlines the entire internal `@cognia/*` type graph into
 * one self-contained `.d.ts`. What is left are `ai`, `dexie` and `react` — all
 * real npm packages already declared as peer dependencies, so they resolve
 * normally in an author's project.
 *
 * The output is vendored into the CLI as a checked-in generated asset by
 * `scripts/plugin/generate-author-types.mjs`, the same pattern
 * `contract.rs` already follows.
 */
export default defineConfig({
  entry: { "cognia-plugin-sdk": "src/index.ts" },
  outDir: ".tsup-author-types",
  target: "es2022",
  platform: "neutral",
  format: ["esm"],
  // `resolve` alone is not enough: tsup marks every `dependencies` /
  // `peerDependencies` entry external by default, and the provider packages are
  // dependencies — so their types stayed as bare imports. `noExternal` opts them
  // back in, and `resolve` then inlines the declarations it pulls.
  noExternal: [/^@cognia\//],
  dts: { only: true, resolve: [/^@cognia\//] },
  clean: true,
})
