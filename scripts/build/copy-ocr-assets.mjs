#!/usr/bin/env node
/**
 * Copy the tesseract.js worker + tesseract.js-core WASM bundles from
 * node_modules into `public/ocr/` so the tesseract-wasm OCR provider can run
 * fully offline (browser, Tauri, and Capacitor shells all serve `public/`).
 * Skip silently when tesseract.js isn't installed (e.g. on a slim CI image).
 *
 * Layout produced:
 *   public/ocr/worker.min.js                        ← tesseract.js/dist
 *   public/ocr/core/tesseract-core-*.wasm.js        ← tesseract.js-core
 *
 * Only the `-lstm` core variants are copied: the provider always creates its
 * worker with the default OEM (LSTM_ONLY), and tesseract.js's browser worker
 * then requests exactly one of tesseract-core{,-simd,-relaxedsimd}-lstm.wasm.js
 * depending on CPU features. The non-lstm (legacy) cores are unreachable.
 *
 * Language traineddata files are NOT copied — they are large and per-language,
 * so `langPath` keeps tesseract.js's CDN default unless the user configures a
 * local mirror in the OCR provider settings.
 *
 * Run before `pnpm build` / `pnpm tauri build`. Idempotent — re-runs are
 * cheap thanks to the existence check.
 */

import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")
const DST = path.resolve(ROOT, "public", "ocr")

const require = createRequire(import.meta.url)

/** Resolve a package.json location, returning null when not installed. */
function resolvePackageDir(pkg, fromDir) {
  try {
    return path.dirname(require.resolve(`${pkg}/package.json`, { paths: [fromDir] }))
  } catch {
    return null
  }
}

const tesseractDir = resolvePackageDir("tesseract.js", ROOT)
if (!tesseractDir) {
  console.log("[ocr] skip: tesseract.js not found (not installed?)")
  process.exit(0)
}
// tesseract.js-core is a transitive dependency — resolve it relative to
// tesseract.js so pnpm's non-hoisted layout is handled.
const coreDir = resolvePackageDir("tesseract.js-core", tesseractDir)
if (!coreDir) {
  console.log("[ocr] skip: tesseract.js-core not found (not installed?)")
  process.exit(0)
}

const COPIES = [
  {
    src: path.join(tesseractDir, "dist", "worker.min.js"),
    dst: path.join(DST, "worker.min.js"),
  },
  ...["tesseract-core-lstm", "tesseract-core-simd-lstm", "tesseract-core-relaxedsimd-lstm"].map(
    (name) => ({
      src: path.join(coreDir, `${name}.wasm.js`),
      dst: path.join(DST, "core", `${name}.wasm.js`),
    })
  ),
]

const missing = COPIES.filter((c) => !fs.existsSync(c.src))
if (missing.length > 0) {
  console.error(`[ocr] error: missing source files:\n${missing.map((c) => `  ${c.src}`).join("\n")}`)
  process.exit(1)
}

if (COPIES.every((c) => fs.existsSync(c.dst))) {
  console.log(`[ocr] skip: ${DST} already populated`)
  process.exit(0)
}

for (const { src, dst } of COPIES) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  console.log(`[ocr] copy ${src} → ${dst}`)
}
console.log("[ocr] done")
