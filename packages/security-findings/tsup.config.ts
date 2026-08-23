import { defineConfig } from "tsup"

// @cognia/security-findings is pure data transformation: no Dexie, no Tauri,
// no filesystem, no crypto module. It runs unchanged in the renderer (the
// Strix plugin panel) and in Node (the `cognia-agent security` CLI), which is
// the whole reason the scan gate and the desktop panel cannot disagree about
// what counts as a finding.
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2017",
  external: [/^@cognia\//],
})
