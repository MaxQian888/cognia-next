#!/usr/bin/env node
/**
 * Copy Monaco's `min/vs` bundle from node_modules into `public/monaco/vs`
 * so the Tauri production build can load Monaco offline. Skip silently
 * when monaco-editor isn't installed (e.g. on a slim CI image).
 *
 * Run before `pnpm build` / `pnpm tauri build`. Idempotent — re-runs are
 * cheap thanks to the size check (~5MB once it has copied the assets).
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const SRC = path.resolve(ROOT, "node_modules", "monaco-editor", "min", "vs")
const DST = path.resolve(ROOT, "public", "monaco", "vs")

function copyRecursive(src, dst) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry))
    }
  } else {
    fs.copyFileSync(src, dst)
  }
}

if (!fs.existsSync(SRC)) {
  console.log(`[monaco] skip: ${SRC} not found (monaco-editor not installed?)`)
  process.exit(0)
}

if (fs.existsSync(DST)) {
  // Cheap freshness check — if the destination already has loader.js,
  // assume an earlier run completed. Re-copy on demand by deleting the
  // directory.
  if (fs.existsSync(path.join(DST, "loader.js"))) {
    console.log(`[monaco] skip: ${DST} already populated`)
    process.exit(0)
  }
}

console.log(`[monaco] copy ${SRC} → ${DST}`)
copyRecursive(SRC, DST)
console.log(`[monaco] done`)
