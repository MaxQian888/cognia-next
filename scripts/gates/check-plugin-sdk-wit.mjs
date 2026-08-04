#!/usr/bin/env node
/**
 * Verify every WIT mirror matches the canonical source.
 *
 * Exits 0 when all mirrors are byte-identical to the source, 1 with a unified
 * diff otherwise. Designed to run in CI and as a local pre-push check so
 * external plugin authors never see a stale contract.
 *
 * The canonical path and the mirror list live in `lib/wit-mirrors.mjs`, shared
 * with the writer so the two cannot disagree. Two of the mirrors are guest-side
 * copies named `world.wit` — this compares content, not filenames.
 *
 * Fix drift by running `pnpm sync:plugin-sdk-wit`.
 */

import { readFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { CANONICAL, MIRRORS } from "./lib/wit-mirrors.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "../..")
const source = resolve(repoRoot, CANONICAL)
const mirrors = MIRRORS.map((p) => resolve(repoRoot, p))

async function readOrFail(path, label) {
  try {
    return await readFile(path, "utf8")
  } catch (err) {
    console.error(`[check-plugin-sdk-wit] missing ${label}: ${path}`)
    throw err
  }
}

function unifiedDiff(aLabel, aText, bLabel, bText) {
  const a = aText.split("\n")
  const b = bText.split("\n")
  const out = [`--- ${aLabel}`, `+++ ${bLabel}`]
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      if (i < a.length) out.push(`-${a[i]}`)
      if (i < b.length) out.push(`+${b[i]}`)
    }
  }
  return out.join("\n")
}

async function main() {
  const sourceContent = await readOrFail(source, "canonical WIT source")
  let drifted = false
  for (const mirror of mirrors) {
    const mirrorContent = await readOrFail(mirror, "WIT mirror")
    if (sourceContent === mirrorContent) {
      console.log(
        `[check-plugin-sdk-wit] ok: ${relative(repoRoot, mirror)} matches canonical source`
      )
      continue
    }
    drifted = true
    console.error(`[check-plugin-sdk-wit] DRIFT detected: ${relative(repoRoot, mirror)}`)
    console.error(
      unifiedDiff(
        relative(repoRoot, source),
        sourceContent,
        relative(repoRoot, mirror),
        mirrorContent
      )
    )
  }
  if (drifted) {
    console.error(`Run \`pnpm sync:plugin-sdk-wit\` to update the mirrors.`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`[check-plugin-sdk-wit] failed:`, err)
  process.exit(1)
})
