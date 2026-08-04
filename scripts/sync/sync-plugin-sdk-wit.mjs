#!/usr/bin/env node
/**
 * Sync the canonical WIT contract into every mirror.
 *
 * The canonical path and the mirror list live in
 * `scripts/gates/lib/wit-mirrors.mjs`, shared with the gate so the two cannot
 * disagree about what is mirrored.
 *
 * Run after editing the canonical file. Idempotent — exits with code 0 and
 * prints "up to date" when the files already match. Use the companion
 * `scripts/gates/check-plugin-sdk-wit.mjs` from CI to fail builds on drift.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { CANONICAL, MIRRORS } from "../gates/lib/wit-mirrors.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "../..")
const source = resolve(repoRoot, CANONICAL)
const mirrors = MIRRORS.map((p) => resolve(repoRoot, p))

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

  for (const mirror of mirrors) {
    const currentMirror = await readOrNull(mirror)
    if (currentMirror === sourceContent) {
      console.log(`[sync-plugin-sdk-wit] up to date: ${mirror}`)
      continue
    }

    await mkdir(dirname(mirror), { recursive: true })
    await writeFile(mirror, sourceContent, "utf8")
    console.log(`[sync-plugin-sdk-wit] wrote ${mirror} (${sourceContent.length} bytes)`)
  }
}

main().catch((err) => {
  console.error(`[sync-plugin-sdk-wit] failed:`, err)
  process.exit(1)
})
