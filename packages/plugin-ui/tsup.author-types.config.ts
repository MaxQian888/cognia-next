import { defineConfig } from "tsup"

/**
 * Author-facing declaration build — see the sibling config in
 * `packages/plugin-sdk` for why this exists.
 *
 * `plugin-ui` has no internal `@cognia/*` type edges today, but the `resolve`
 * entry is kept so that adding one (a shared token module, say) does not
 * silently emit an unresolvable import into a vendored author asset. Everything
 * it does import — `radix-ui`, `react`, `class-variance-authority` — is a real
 * npm package the author already installs.
 */
export default defineConfig({
  entry: { "cognia-plugin-ui": "src/index.ts" },
  outDir: ".tsup-author-types",
  target: "es2022",
  platform: "neutral",
  format: ["esm"],
  dts: { only: true, resolve: [/^@cognia\//] },
  clean: true,
})
