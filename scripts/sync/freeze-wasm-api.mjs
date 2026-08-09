#!/usr/bin/env node
/**
 * Regenerate the frozen WASM plugin host API digest manifest.
 *
 * Writes `scripts/gates/frozen-wasm-api.json` from whatever is currently on
 * disk under the frozen root. Run this ONLY when intentionally re-freezing —
 * for example when adding a `v0_2/` sibling as v0.3 lands. Running it to make
 * `pnpm lint:frozen-wasm-api` pass after an accidental edit defeats the entire
 * point of the gate.
 *
 * The filename deliberately avoids `check|test|lint|audit|verify|validate` so
 * `scripts/gates/check-gate-registry.mjs` does not treat it as a gate needing
 * registration — it is a writer, not a check.
 */

import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { digest, listFilesRecursive, MANIFEST_PATH } from "../gates/check-frozen-wasm-api.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "../..")

const FROZEN_ROOT = "crates/cognia-plugin-runtime/frozen/v0_1"

const NOTE =
  "The v0.1 WASM plugin contract is frozen. These files are historical artifacts, " +
  "are not compiled, and must never change. To evolve the contract, add a new " +
  "`since_v0_N` linker — do not edit these. Regenerate ONLY when intentionally " +
  "re-freezing: pnpm freeze:wasm-api"

async function main() {
  const rootAbs = resolve(repoRoot, FROZEN_ROOT)
  const relPaths = await listFilesRecursive(rootAbs)

  const files = []
  for (const relPath of relPaths) {
    const buf = await readFile(resolve(rootAbs, relPath))
    files.push({ path: relPath, sha256: digest(buf), bytes: buf.length })
  }

  const manifest = { note: NOTE, root: FROZEN_ROOT, files }
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

  console.log(`[freeze-wasm-api] wrote ${MANIFEST_PATH}`)
  for (const file of files) {
    console.log(`  ${file.path}  ${file.bytes} bytes  ${file.sha256}`)
  }
}

main().catch((err) => {
  console.error(`[freeze-wasm-api] failed:`, err)
  process.exit(1)
})
