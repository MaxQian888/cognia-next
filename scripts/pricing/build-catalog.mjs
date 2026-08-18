#!/usr/bin/env node
/**
 * Regenerate the bundled model price catalog from LiteLLM's public cost map.
 *
 * WHY: `types/system/usage.ts` carries a hand-maintained price table. It went
 * five months stale without anything noticing, and it was missing entire model
 * families — a model absent from every layer prices as "unknown", which the UI
 * used to render as $0.00. LiteLLM maintains the same data for ~2,500 models
 * with cache-tier rates, so the floor layer is now derived instead of typed.
 *
 * NETWORK IS MANUAL ON PURPOSE. This script fetches; the CI gate
 * (`scripts/gates/check-price-catalog.mjs`) only validates the committed
 * artifact offline. Making CI fetch would put every build at the mercy of a
 * third-party host being reachable.
 *
 *   pnpm pricing:sync           # refresh the artifact
 *   pnpm pricing:catalog:check  # validate the committed artifact (also in CI)
 *
 * The output is filtered to providers this app actually ships and trimmed to
 * the pricing + context fields, because the same `out/` is consumed by the
 * Capacitor mobile shell: the raw upstream file is ~1.7 MB.
 */

import { writeFileSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..", "..")
export const CATALOG_PATH = path.join(
  REPO_ROOT,
  "lib",
  "usage",
  "model-price-catalog.generated.json"
)

const SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

/**
 * LiteLLM `litellm_provider` values worth keeping, mapped to this app's
 * provider ids. Anything else is dropped — carrying Bedrock/Vertex/Azure
 * re-exports of models we already have under their first-party id would triple
 * the artifact for no new prices.
 */
export const PROVIDER_MAP = Object.freeze({
  anthropic: "anthropic",
  openai: "openai",
  gemini: "google",
  vertex_ai: "google",
  deepseek: "deepseek",
  groq: "groq",
  mistral: "mistral",
  cohere: "cohere",
  cohere_chat: "cohere",
  xai: "xai",
  together_ai: "togetherai",
  fireworks_ai: "fireworks",
  cerebras: "cerebras",
  openrouter: "openrouter",
  ollama: "ollama",
  sambanova: "sambanova",
})

/** Per-token → per-1M, dropping absent/zero-ish noise. */
function per1M(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  // Round to 6 decimals of a per-1M rate: enough for sub-cent models, and it
  // keeps the artifact byte-stable across floating-point noise upstream.
  return Number((value * 1_000_000).toFixed(6))
}

function positiveInt(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

/** Project one upstream entry onto the fields this app prices with. */
export function projectEntry(raw) {
  const promptPer1M = per1M(raw?.input_cost_per_token)
  const completionPer1M = per1M(raw?.output_cost_per_token)
  // A row with no base rate has no usable anchor — `mergePricingLayers` would
  // reject it anyway, so it is not worth the bytes.
  if (promptPer1M === undefined && completionPer1M === undefined) return undefined

  const out = {}
  if (promptPer1M !== undefined) out.promptPer1M = promptPer1M
  if (completionPer1M !== undefined) out.completionPer1M = completionPer1M

  const cachedInputPer1M = per1M(raw?.cache_read_input_token_cost)
  if (cachedInputPer1M !== undefined) out.cachedInputPer1M = cachedInputPer1M
  const cacheCreationPer1M = per1M(raw?.cache_creation_input_token_cost)
  if (cacheCreationPer1M !== undefined) out.cacheCreationPer1M = cacheCreationPer1M

  const maxInput = positiveInt(raw?.max_input_tokens)
  if (maxInput !== undefined) out.maxInputTokens = maxInput
  const maxOutput = positiveInt(raw?.max_output_tokens)
  if (maxOutput !== undefined) out.maxOutputTokens = maxOutput

  return out
}

/** Build the artifact object from a parsed upstream cost map. */
export function buildCatalog(upstream) {
  /** @type {Record<string, Record<string, unknown>>} */
  const byProvider = {}
  for (const [modelId, raw] of Object.entries(upstream)) {
    // Upstream ships a `sample_spec` pseudo-entry documenting the schema.
    if (modelId === "sample_spec") continue
    const ourProvider = PROVIDER_MAP[raw?.litellm_provider]
    if (!ourProvider) continue
    const projected = projectEntry(raw)
    if (!projected) continue
    // Strip the `provider/` prefix LiteLLM uses for non-first-party routes so
    // the key matches the model id this app actually sends.
    const bare = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId
    byProvider[ourProvider] ??= {}
    // First write wins: entries are visited in upstream order, and the
    // unprefixed first-party id appears before its re-exports.
    byProvider[ourProvider][bare] ??= projected
  }

  // Sort every level so regeneration is byte-stable and diffs stay reviewable.
  const sorted = {}
  for (const provider of Object.keys(byProvider).sort()) {
    const models = byProvider[provider]
    const sortedModels = {}
    for (const modelId of Object.keys(models).sort()) sortedModels[modelId] = models[modelId]
    sorted[provider] = sortedModels
  }
  return { source: SOURCE_URL, providers: sorted }
}

/** Deterministic serialization — the gate compares bytes. */
export function serializeCatalog(catalog) {
  return JSON.stringify(catalog, null, 2) + "\n"
}

export function readCommittedCatalog() {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8"))
}

async function main() {
  const res = await fetch(SOURCE_URL)
  if (!res.ok) {
    console.error(`pricing:sync failed — ${res.status} ${res.statusText} from ${SOURCE_URL}`)
    process.exit(1)
  }
  const upstream = await res.json()
  const catalog = buildCatalog(upstream)
  const serialized = serializeCatalog(catalog)
  writeFileSync(CATALOG_PATH, serialized)

  const providers = Object.keys(catalog.providers).length
  const models = Object.values(catalog.providers).reduce((n, m) => n + Object.keys(m).length, 0)
  const kb = Math.round(Buffer.byteLength(serialized) / 1024)
  console.log(`wrote ${path.relative(REPO_ROOT, CATALOG_PATH)}`)
  console.log(`  ${providers} providers, ${models} models, ${kb} KB`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
