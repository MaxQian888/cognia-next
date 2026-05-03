// One-shot script: merge Cognia's `providers` and `providerParams` i18n
// namespaces into cognia-next's flat `i18n/messages/{en,zh-CN}.json`.
// Run from the cognia-next repo root: `node scripts/merge-provider-i18n.mjs`.

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const COGNIA_ROOT = "D:/Project/Cognia/lib/i18n/messages"
const NEXT_ROOT = "D:/Project/cognia-next/i18n/messages"

const LOCALES = [
  { id: "en", cogniaDir: "en", nextFile: "en.json" },
  { id: "zh-CN", cogniaDir: "zh-CN", nextFile: "zh-CN.json" },
]

function read(p) {
  return JSON.parse(readFileSync(p, "utf8"))
}

for (const { id, cogniaDir, nextFile } of LOCALES) {
  const aiPath = join(COGNIA_ROOT, cogniaDir, "ai.json")
  const paramsPath = join(COGNIA_ROOT, cogniaDir, "providerParams.json")
  const nextPath = join(NEXT_ROOT, nextFile)

  const ai = read(aiPath)
  const params = read(paramsPath)
  const next = read(nextPath)

  // Cognia's `ai.json` has `aiSettings` (top-level) and `providers` (top-level).
  // We only want the `providers` block.
  const providersBlock = ai.providers
  if (!providersBlock) {
    console.error(`[${id}] Cognia ai.json has no top-level 'providers' key`)
    process.exit(1)
  }

  // providerParams.json's root IS the providerParams namespace.
  // The file looks like { "providerParams": { ... } }.
  const paramsBlock = params.providerParams ?? params
  if (!paramsBlock) {
    console.error(`[${id}] Cognia providerParams.json has no content`)
    process.exit(1)
  }

  next.providers = providersBlock
  next.providerParams = paramsBlock

  // Add settings.tabs.providers + settings.descriptions.providers so the
  // sidebar nav can find them via the existing nav config pattern.
  next.settings = next.settings ?? {}
  next.settings.tabs = next.settings.tabs ?? {}
  next.settings.descriptions = next.settings.descriptions ?? {}
  if (id === "en") {
    next.settings.tabs.providers = "Providers"
    next.settings.descriptions.providers = "AI provider API keys, models, and connection settings."
  } else {
    next.settings.tabs.providers = "提供商"
    next.settings.descriptions.providers = "AI 提供商的 API 密钥、模型与连接设置。"
  }

  writeFileSync(nextPath, JSON.stringify(next, null, 2) + "\n", "utf8")
  console.log(
    `[${id}] merged providers (${Object.keys(providersBlock).length} keys) + providerParams (${Object.keys(paramsBlock).length} keys) into ${nextFile}`
  )
}
