// Bundle the standalone agent CLI into a single Node ESM file.
//
// The CLI lives inside the main TS graph (so it reuses lib/claude/* directly),
// so the bundle pulls a reachable slice of the app's TS. esbuild resolves the
// `@/*` alias via the root tsconfig. A few browser-only modules are aliased to
// Node stubs (mirrors the next.config.ts browser-stub pattern); add more here
// as the bundle surfaces them.
//
// Usage: node scripts/build-cli.mjs   (requires `pnpm add -D esbuild`)

import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.dirname(fileURLToPath(import.meta.url)) + "/.."
const entry = path.join(root, "cli/src/cli/entry.ts")
const outfile = path.join(root, "cli/dist/cognia-agent.mjs")

let esbuild
try {
  esbuild = await import("esbuild")
} catch {
  console.error("build-cli: esbuild is not installed. Run: pnpm add -D esbuild")
  process.exit(1)
}

await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  tsconfig: path.join(root, "tsconfig.json"),
  banner: { js: "#!/usr/bin/env node" },
  // Keep optional native deps external — they belong to the sidecar process,
  // not the CLI driver.
  external: ["node-pty", "fsevents"],
  logLevel: "info",
})

console.log(`build-cli: wrote ${path.relative(root, outfile)}`)
