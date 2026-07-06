#!/usr/bin/env node
/**
 * Copy the tree-sitter grammar `.wasm` files the code-graph subsystem needs
 * from `sidecar/node_modules/tree-sitter-wasms/out` into
 * `sidecar/builtin-tools/code/grammars/` so the Tauri production build (which
 * ships only enumerated sidecar paths) and the CLI bundle can load them
 * offline. esbuild can't inline `.wasm` data files, so they must be copied as
 * sibling assets — the same pattern as `copy-monaco-assets.mjs`.
 *
 * Run before `pnpm build` / `pnpm tauri build` (wired into predev/prebuild).
 * Skips silently when tree-sitter-wasms isn't installed (slim CI image).
 * Idempotent — re-copies only when missing or stale (size mismatch).
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { grammarAssets } from "../../sidecar/builtin-tools/code/languages/index.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")
const SRC = path.resolve(ROOT, "sidecar", "node_modules", "tree-sitter-wasms", "out")
const DST = path.resolve(ROOT, "sidecar", "builtin-tools", "code", "grammars")

if (!fs.existsSync(SRC)) {
  console.log(`[codegraph] skip: ${SRC} not found (tree-sitter-wasms not installed?)`)
  process.exit(0)
}

fs.mkdirSync(DST, { recursive: true })

let copied = 0
let missing = 0
for (const asset of grammarAssets()) {
  const src = path.join(SRC, asset)
  const dst = path.join(DST, asset)
  if (!fs.existsSync(src)) {
    console.warn(`[codegraph] WARN grammar not shipped by tree-sitter-wasms: ${asset}`)
    missing++
    continue
  }
  if (fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size) {
    continue // up to date
  }
  fs.copyFileSync(src, dst)
  copied++
}

console.log(
  `[codegraph] grammars → ${DST} (${copied} copied, ${grammarAssets().length - missing} present)`
)
