import { defineConfig } from "tsup"

// @cognia/redact is source-first for the app: tsconfig `paths`, Jest's
// moduleNameMapper and webpack all resolve it to `src/`.
//
// This build exists for the Claude sidecar, which runs under plain Node and
// links the package (`link:` in sidecar/package.json). Tauri stages the
// sidecar's `node_modules` by dereferencing that link, so the shipped copy is
// real files under `node_modules`, where Node refuses to strip types
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). The `node` export condition
// therefore points at this compiled output. Keep it current with
// `node scripts/build/build-sidecar-linked-packages.mjs`.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
})
