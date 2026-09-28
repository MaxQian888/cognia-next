import { defineConfig } from "tsup"
// static-export-exempt: Node-only tsup build configuration; never imported by app or SDK runtime code.
import { fileURLToPath } from "node:url"

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url))

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
  entry: { "cognia-plugin-sdk": local("./src/index.ts") },
  tsconfig: local("./tsconfig.json"),
  outDir: local("./.tsup-author-types"),
  target: "es2022",
  platform: "neutral",
  format: ["esm"],
  // The generator runs this cwd-independent config from the verified root:
  // tsup 8 marks cwd production dependencies external even with noExternal.
  // Absolute source paths/baseUrl preserve resolution when cwd changes.
  noExternal: [/^@cognia\//],
  dts: { only: true, resolve: [/^@cognia\//], compilerOptions: { baseUrl: local("./") } },
  clean: true,
})
