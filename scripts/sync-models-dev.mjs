// Downloads the models.dev catalog (https://models.dev/api.json) and writes it
// verbatim to lib/ai/providers/models-dev-snapshot.json. This bundled snapshot
// is the offline / first-run fallback for the provider catalog; the running app
// refreshes it at runtime via lib/ai/providers/models-dev-sync.ts.
//
// Normalization (models.dev -> our ModelConfig) deliberately stays in TypeScript
// (lib/ai/providers/models-dev.ts) so there is a single source of truth — this
// script only fetches the raw payload.
//
// Usage: pnpm sync:models-dev

import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const API_URL = "https://models.dev/api.json"
const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = resolve(__dirname, "../lib/ai/providers/models-dev-snapshot.json")

async function main() {
  process.stdout.write(`Fetching ${API_URL} ...\n`)
  const res = await fetch(API_URL, { headers: { accept: "application/json" } })
  if (!res.ok) {
    throw new Error(`models.dev returned HTTP ${res.status} ${res.statusText}`)
  }
  const json = await res.json()
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("models.dev payload is not a provider map object")
  }

  const providerCount = Object.keys(json).length
  let modelCount = 0
  for (const provider of Object.values(json)) {
    if (provider && typeof provider === "object" && provider.models) {
      modelCount += Object.keys(provider.models).length
    }
  }
  if (providerCount === 0 || modelCount === 0) {
    throw new Error(
      `models.dev payload looks empty (providers=${providerCount}, models=${modelCount})`
    )
  }

  // Pretty-print so the diff is reviewable in PRs.
  await writeFile(OUT_PATH, JSON.stringify(json, null, 2) + "\n", "utf8")
  process.stdout.write(
    `Wrote ${OUT_PATH}\n  providers: ${providerCount}\n  models: ${modelCount}\n`
  )
}

main().catch((err) => {
  process.stderr.write(`sync-models-dev failed: ${err?.message ?? err}\n`)
  process.exitCode = 1
})
