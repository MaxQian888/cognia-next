import { defineConfig } from "tsup"

// @cognia/agent-config-types is source-first for the app (tsconfig `paths`,
// Jest's moduleNameMapper, webpack), and almost all of it is types.
//
// This build exists for the Claude sidecar, which runs under plain Node and
// imports the few runtime modules below through its `link:` dependency. Tauri
// stages the sidecar's `node_modules` by dereferencing that link, so the
// shipped copy is real files under `node_modules`, where Node refuses to strip
// types (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Each entry here gets a
// `node` export condition pointing at its compiled output; add both together
// when the sidecar starts importing another runtime module. Keep it current
// with `node scripts/build/build-sidecar-linked-packages.mjs`.
export default defineConfig({
  entry: ["src/claude-agent-sdk-options.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
})
