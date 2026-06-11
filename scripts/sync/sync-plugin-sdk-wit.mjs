#!/usr/bin/env node
/**
 * Sync the canonical WIT contract into the public plugin-sdk mirror.
 *
 * Source of truth: `src-tauri/wit/cognia-plugin.wit`
 * Mirror:          `plugin-sdk/wit/cognia-plugin.wit`
 *
 * Run after editing the canonical file. Idempotent — exits with code 0 and
 * prints "up to date" when the files already match. Use the companion
 * `scripts/check-plugin-sdk-wit.mjs` from CI to fail builds on drift.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "../..")
const source = resolve(repoRoot, "src-tauri/wit/cognia-plugin.wit")
const mirror = resolve(repoRoot, "plugin-sdk/wit/cognia-plugin.wit")

async function readOrNull(path) {
  try {
    return await readFile(path, "utf8")
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return null
    }
    throw err
  }
}

async function main() {
  const sourceContent = await readOrNull(source)
  if (sourceContent === null) {
    console.error(`[sync-plugin-sdk-wit] source not found: ${source}`)
    process.exit(2)
  }

  const currentMirror = await readOrNull(mirror)
  if (currentMirror === sourceContent) {
    console.log(`[sync-plugin-sdk-wit] up to date: ${mirror}`)
    return
  }

  await mkdir(dirname(mirror), { recursive: true })
  await writeFile(mirror, sourceContent, "utf8")
  console.log(`[sync-plugin-sdk-wit] wrote ${mirror} (${sourceContent.length} bytes)`)
}

main().catch((err) => {
  console.error(`[sync-plugin-sdk-wit] failed:`, err)
  process.exit(1)
})
