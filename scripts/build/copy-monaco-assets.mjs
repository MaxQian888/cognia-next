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
const ROOT = path.resolve(__dirname, "../..")
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

// The staged copy must track the installed package: a `loader.js`-exists
// check once left a pre-0.56 snapshot in place for months — the hashed
// language workers (`ts.worker-*.js` et al.) never arrived and desktop
// syntax checking silently produced zero diagnostics. Stamp the source
// version alongside the assets and re-copy on any drift.
const STAMP = path.join(DST, ".monaco-version")
const srcVersion = JSON.parse(
  fs.readFileSync(path.join(SRC, "..", "..", "package.json"), "utf8")
).version

if (fs.existsSync(DST)) {
  const staged = fs.existsSync(STAMP)
    ? fs.readFileSync(STAMP, "utf8").trim()
    : null
  if (staged === srcVersion && fs.existsSync(path.join(DST, "loader.js"))) {
    console.log(`[monaco] skip: ${DST} already populated (v${srcVersion})`)
    process.exit(0)
  }
  fs.rmSync(DST, { recursive: true, force: true })
}

console.log(`[monaco] copy ${SRC} → ${DST} (v${srcVersion})`)
copyRecursive(SRC, DST)
fs.writeFileSync(STAMP, `${srcVersion}\n`)
console.log(`[monaco] done`)
