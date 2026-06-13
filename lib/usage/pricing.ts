/**
 * Single source of truth for per-model pricing + cost computation, shared by
 * the GUI usage analytics (`session-analytics.ts`), the CLI footer/usage panel
 * (`cli/src/tui/format/usage.ts`), the workflow run aggregator, and the routing
 * engine's cost-aware ranking (`model-pricing.ts`).
 *
 * Before this module there were two disjoint pricing systems — one keyed off
 * the static `MODEL_PRICING`/CNY tables (UI display, returned only
 * `{input,output}`) and one off the built-in catalog (routing) — and neither
 * consulted the freshest source, the synced models.dev catalog. The CLI and
 * GUI therefore priced the same turn differently. This module collapses them.
 *
 * Resolution order (highest authority first); each layer is normalized to USD
 * and merged field-by-field, so a custom override of just the input rate still
 * inherits the catalog's cache rates:
 *   1. user custom-provider metadata pricing
 *   2. account-discovered model pricing (live /v1/models)
 *   3. models.dev catalog (freshest global metadata; carries cache/batch rates)
 *   4. static MODEL_PRICING / MODEL_PRICING_CNY tables (by model id)
 *   5. built-in PROVIDERS catalog
 *
 * Pure given the injected `catalog` reader; the default reads the in-memory
 * synced catalog so callers get "catalog-first" pricing without extra wiring.
 */

import { getModelConfig, type ModelPricing } from "@/types/provider/provider"
import { getCatalogModelMetadata } from "@/lib/ai/providers/models-dev-sync"
import { MODEL_PRICING, MODEL_PRICING_CNY, CURRENCIES } from "@/types/system/usage"

/**
 * Cache multipliers relative to the base input rate (Anthropic prompt-caching:
 * a read is billed at 0.1×, a 5-minute write at 1.25×). Applied ONLY when no
 * explicit cache rate is known for the model — when the catalog carries real
 * `cachedInputPer1M`/`cacheCreationPer1M` (OpenAI, DeepSeek, Anthropic, …) those
 * win, so non-Anthropic providers are priced by their own cache economics.
 */
export const DEFAULT_CACHE_READ_MULT = 0.1
export const DEFAULT_CACHE_WRITE_MULT = 1.25

/** Per-provider custom + discovered pricing seams (subset of the settings store). */
export interface PricingSettings {
  providerSettings?: Record<
    string,
    { discoveredModels?: Array<{ id: string; pricing?: Partial<ModelPricing> }> } | undefined
  >
  customProviders?: Array<{
    id: string
    customModelMetadata?: Record<string, { pricing?: Partial<ModelPricing> } | undefined>
  }>
}

/** Look up models.dev catalog pricing for a (provider, model). */
export type CatalogPricingLookup = (
  providerId: string,
  modelId: string
) => Partial<ModelPricing> | undefined

export interface ResolvePricingOptions {
  settings?: PricingSettings
  /** models.dev catalog seam; defaults to the in-memory synced catalog. */
  catalog?: CatalogPricingLookup
}

/** The numeric per-1M-token rate fields of {@link ModelPricing}. */
const PRICING_FIELDS = [
  "promptPer1M",
  "completionPer1M",
  "cachedInputPer1M",
  "cacheCreationPer1M",
  "batchInputPer1M",
  "batchOutputPer1M",
  "audioInputPer1M",
  "audioOutputPer1M",
] as const

type PricingField = (typeof PRICING_FIELDS)[number]

/** Convert a pricing layer to USD (divides CNY values by the CNY→USD rate). */
function toUsd(p: Partial<ModelPricing> | undefined): Partial<ModelPricing> | undefined {
  if (!p) return undefined
  if (p.currency !== "CNY") return p
  const rate = CURRENCIES.CNY.rateFromUSD || 1
  const out: Partial<ModelPricing> = { currency: "USD" }
  for (const f of PRICING_FIELDS) {
    const v = p[f]
    if (typeof v === "number") out[f] = v / rate
  }
  return out
}

/** Static MODEL_PRICING / MODEL_PRICING_CNY layer for a model id (USD). */
function staticTablePricing(modelId: string): Partial<ModelPricing> | undefined {
  const usd = MODEL_PRICING[modelId]
  if (usd) return { promptPer1M: usd.input, completionPer1M: usd.output }
  const cny = MODEL_PRICING_CNY[modelId]
  if (cny) {
    const rate = CURRENCIES.CNY.rateFromUSD || 1
    return { promptPer1M: cny.input / rate, completionPer1M: cny.output / rate }
  }
  return undefined
}

/**
 * Field-merge pricing layers (highest priority first), normalizing each to USD.
 * Returns null when no layer carries a base (prompt/completion) rate — a
 * cache-only layer has no usable anchor, mirroring the catalog mapper's policy.
 *
 * Unset rates are left `undefined` (not coerced to 0) so the routing engine's
 * blended-ranking figure can reuse the present side, and so a genuinely-free
 * $0 model stays distinguishable from "rate unknown".
 */
export function mergePricingLayers(
  layers: Array<Partial<ModelPricing> | undefined>
): Partial<ModelPricing> | null {
  const merged: Partial<Record<PricingField, number>> = {}
  for (const raw of layers) {
    const layer = toUsd(raw)
    if (!layer) continue
    for (const f of PRICING_FIELDS) {
      const v = layer[f]
      if (merged[f] === undefined && typeof v === "number") merged[f] = v
    }
  }
  if (merged.promptPer1M === undefined && merged.completionPer1M === undefined) return null
  const result: Partial<ModelPricing> = { currency: "USD" }
  for (const f of PRICING_FIELDS) {
    if (merged[f] !== undefined) result[f] = merged[f]
  }
  return result
}

const defaultCatalogLookup: CatalogPricingLookup = (providerId, modelId) =>
  getCatalogModelMetadata(providerId, modelId)?.pricing

/**
 * Resolve the full USD pricing for a (provider, model), layering custom >
 * discovered > models.dev catalog > static tables > built-in catalog. Returns
 * null when no rate is known anywhere.
 */
export function resolveModelPricingUsd(
  providerId: string | undefined,
  modelId: string | undefined,
  opts: ResolvePricingOptions = {}
): Partial<ModelPricing> | null {
  if (!modelId) return null
  const catalog = opts.catalog ?? defaultCatalogLookup
  const layers: Array<Partial<ModelPricing> | undefined> = []
  if (providerId) {
    layers.push(
      opts.settings?.customProviders?.find((p) => p.id === providerId)?.customModelMetadata?.[
        modelId
      ]?.pricing
    )
    layers.push(
      opts.settings?.providerSettings?.[providerId]?.discoveredModels?.find((m) => m.id === modelId)
        ?.pricing
    )
    layers.push(catalog(providerId, modelId))
  }
  layers.push(staticTablePricing(modelId))
  if (providerId) layers.push(getModelConfig(providerId, modelId)?.pricing)
  return mergePricingLayers(layers)
}

/** Token breakdown for {@link costFromTokensUsd}. All fields optional / default 0. */
export interface CostTokens {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

/**
 * Cost of one turn (or session total) in USD from a token breakdown and a
 * resolved pricing record. Explicit cache rates are used when the pricing
 * carries them; otherwise cache reads/writes fall back to the input rate scaled
 * by the Anthropic multipliers. Returns 0 when pricing is null or all-zero.
 */
export function costFromTokensUsd(
  tokens: CostTokens,
  pricing: Partial<ModelPricing> | null
): number {
  if (!pricing) return 0
  const inRate = pricing.promptPer1M || 0
  const outRate = pricing.completionPer1M || 0
  const readRate = pricing.cachedInputPer1M ?? inRate * DEFAULT_CACHE_READ_MULT
  const writeRate = pricing.cacheCreationPer1M ?? inRate * DEFAULT_CACHE_WRITE_MULT
  if (inRate === 0 && outRate === 0 && readRate === 0 && writeRate === 0) return 0
  return (
    ((tokens.inputTokens ?? 0) * inRate +
      (tokens.outputTokens ?? 0) * outRate +
      (tokens.cacheReadInputTokens ?? 0) * readRate +
      (tokens.cacheCreationInputTokens ?? 0) * writeRate) /
    1_000_000
  )
}

/**
 * Convenience: resolve pricing for a (provider, model) and price a token
 * breakdown in one call. Returns `{ cost, known }` so callers can distinguish a
 * genuine $0 (free model) from "no pricing data" (`known: false`).
 */
export function priceTokensForModel(
  providerId: string | undefined,
  modelId: string | undefined,
  tokens: CostTokens,
  opts?: ResolvePricingOptions
): { cost: number; known: boolean } {
  const pricing = resolveModelPricingUsd(providerId, modelId, opts)
  return { cost: costFromTokensUsd(tokens, pricing), known: pricing !== null }
}
