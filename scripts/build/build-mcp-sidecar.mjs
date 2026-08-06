#!/usr/bin/env node

// Build `sidecar/cognia-mcp.mjs` — the External Bridge's stdio MCP sidecar.
//
// The Rust HTTP proxy (`crates/cognia-mcp-server/src/sidecar.rs`) spawns
// `node <sidecar_path>`, so that path must point at a file that exists. It did
// not on desktop: `cognia-mcp.mjs` was only ever produced by
// `build-cli-binary.mjs` into the headless CLI layout (`cli/dist/bin/sidecar/`),
// while the desktop app looked for `~/.cognia/cognia-mcp.js` — a convention no
// build step, installer or first-run task ever wrote. The External Bridge's
// HTTP transport therefore could not start on a packaged desktop install, and
// the client setup snippet printed a path that was not there.
//
// This mirrors `build-vscode-ext-host-sidecar.mjs` / `build-webclone-sidecar.mjs`:
// it runs from `prebuild`, and the output is listed in `tauri.conf.json`
// resources so `resolveResource()` finds it at runtime.

import { existsSync, mkdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import * as esbuild from "esbuild"

import { newestMtimeMs } from "./lib/newest-mtime.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..", "..")
const entry = join(root, "lib/external-bridge/mcp-server/standalone-entry.ts")
const bridgeRuntime = join(root, "scripts/build/mcp-bridge-runtime.ts")
const outfile = join(root, "sidecar", "cognia-mcp.mjs")

// Imports the packaged sidecar cannot satisfy in-process (Dexie tables and
// handlers that live in the renderer): they are rewritten to the host-proxy
// adapter. Kept byte-identical to `build-cli-binary.mjs` — one drifting list
// would give the desktop and headless sidecars different tool surfaces.
const HOST_BRIDGED_IMPORTS = new Set([
  "@/lib/db/wiki-articles",
  "@/lib/db/skills",
  "@/lib/db/characters",
  "../audit-log",
  "../handlers/orchestration",
  "../handlers/rag",
  "../handlers/runtime",
  "../handlers/wiki",
  "../handlers/connectors",
  "../handlers/inbound",
  "../handlers/memory",
  "../handlers/workflow",
])

const hostBridgePlugin = {
  name: "cognia-mcp-host-bridge",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) =>
      HOST_BRIDGED_IMPORTS.has(args.path) ? { path: bridgeRuntime } : undefined
    )
  },
}

const CREATE_REQUIRE_BANNER =
  "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"

const ASSET_LOADERS = {
  ".ttf": "empty",
  ".css": "empty",
  ".svg": "empty",
  ".woff": "empty",
  ".woff2": "empty",
}

function isFresh() {
  if (!existsSync(outfile)) return false
  const newestSrc = Math.max(
    newestMtimeMs(join(root, "lib/external-bridge")),
    newestMtimeMs(join(root, "scripts/build"), { exts: [".ts", ".mjs"] })
  )
  return newestSrc > 0 && statSync(outfile).mtimeMs > newestSrc
}

async function main() {
  if (!existsSync(entry)) {
    process.stderr.write(`[build-mcp-sidecar] entry not found at ${entry}; skipping\n`)
    return
  }
  if (isFresh()) {
    process.stdout.write("[build-mcp-sidecar] up to date; skipping\n")
    return
  }

  mkdirSync(dirname(outfile), { recursive: true })
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    tsconfig: join(root, "tsconfig.json"),
    plugins: [hostBridgePlugin],
    banner: { js: CREATE_REQUIRE_BANNER },
    loader: ASSET_LOADERS,
    logLevel: "info",
  })

  if (!existsSync(outfile)) {
    process.stderr.write("[build-mcp-sidecar] esbuild reported success but produced no file\n")
    process.exit(1)
  }
  process.stdout.write(`[build-mcp-sidecar] ok -> ${relative(root, outfile)}\n`)
}

await main()
