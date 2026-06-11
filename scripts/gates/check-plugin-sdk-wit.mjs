#!/usr/bin/env node
/**
 * Verify the plugin-sdk WIT mirror matches the canonical source.
 *
 * Exits 0 when the two files are byte-identical, 1 with a unified diff
 * otherwise. Designed to run in CI and as a local pre-push check so
 * external plugin authors never see a stale contract.
 *
 * Canonical source: `src-tauri/wit/cognia-plugin.wit`
 * Mirror:           `plugin-sdk/wit/cognia-plugin.wit`
 *
 * Fix drift by running `pnpm sync:plugin-sdk-wit`.
 */

import { readFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "../..")
const source = resolve(repoRoot, "src-tauri/wit/cognia-plugin.wit")
const mirror = resolve(repoRoot, "plugin-sdk/wit/cognia-plugin.wit")

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
  const [sourceContent, mirrorContent] = await Promise.all([
    readOrFail(source, "canonical WIT source"),
    readOrFail(mirror, "plugin-sdk WIT mirror"),
  ])

  if (sourceContent === mirrorContent) {
    console.log(`[check-plugin-sdk-wit] ok: ${relative(repoRoot, mirror)} matches canonical source`)
    return
  }

  console.error(
    `[check-plugin-sdk-wit] DRIFT detected between canonical source and plugin-sdk mirror.`
  )
  console.error(`  source: ${source}`)
  console.error(`  mirror: ${mirror}`)
  console.error(``)
  console.error(
    unifiedDiff(
      relative(repoRoot, source),
      sourceContent,
      relative(repoRoot, mirror),
      mirrorContent
    )
  )
  console.error(``)
  console.error(`Run \`pnpm sync:plugin-sdk-wit\` to update the mirror.`)
  process.exit(1)
}

main().catch((err) => {
  console.error(`[check-plugin-sdk-wit] failed:`, err)
  process.exit(1)
})
