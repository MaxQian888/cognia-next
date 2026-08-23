import { defineConfig } from "tsup"

// @cognia/network-guard is a pure classifier: no fetch, no DNS, no Node
// built-ins, no Dexie, no Tauri. It runs unchanged in the renderer (the
// `web_fetch` gate and the connector inbound-media floor) and in Node (the
// isolated `sidecar/webclone` child process), which is the whole reason those
// three call sites cannot disagree about what counts as a private target.
//
// The compiled output is NOT optional for the sidecar: Node hard-refuses to
// strip types from any file under `node_modules`
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and webclone installs this
// package physically (`--install-links`) so the Tauri bundle ships real files
// rather than a workspace symlink. Source-only would resolve in the app and
// crash in the sidecar.
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2017",
  external: [/^@cognia\//],
})
