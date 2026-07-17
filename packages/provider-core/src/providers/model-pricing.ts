import { getModelConfig, type ModelPricing } from "@cognia/provider-types/provider"
import { getCatalogModelMetadata } from "./models-dev-sync"
import { parseReasoningSuffix } from "./reasoning-suffix"

/**
 * Resolve a comparable per-1M-token USD price for a provider:model, used by the
 * routing engine's cost-aware strategy. The package-local default keeps
 * provider-core independent from the app by reading custom metadata, discovered
 * models, the injected models.dev cache, and the built-in catalog. The host can
 * inject a richer resolver that also includes app-only legacy static tables.
 */

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

export interface ResolvePricingOptions {
  settings?: PricingSettings
}

export type ModelPricingResolver = (
  providerId: string | undefined,
  modelId: string | undefined,
  options?: ResolvePricingOptions
) => Partial<ModelPricing> | null

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

function toUsd(p: Partial<ModelPricing> | undefined): Partial<ModelPricing> | undefined {
  if (!p) return undefined
  if (p.currency !== "CNY") return p
  const rate = 7.25
  const out: Partial<ModelPricing> = { currency: "USD" }
  for (const field of PRICING_FIELDS) {
    const value = p[field]
    if (typeof value === "number") out[field] = value / rate
  }
  return out
}

export function mergePricingLayers(
  layers: Array<Partial<ModelPricing> | undefined>
): Partial<ModelPricing> | null {
  const merged: Partial<Record<PricingField, number>> = {}
  for (const raw of layers) {
    const layer = toUsd(raw)
    if (!layer) continue
    for (const field of PRICING_FIELDS) {
      const value = layer[field]
      if (merged[field] === undefined && typeof value === "number") {
        merged[field] = value
      }
    }
  }
  if (merged.promptPer1M === undefined && merged.completionPer1M === undefined) return null
  const result: Partial<ModelPricing> = { currency: "USD" }
  for (const field of PRICING_FIELDS) {
    if (merged[field] !== undefined) result[field] = merged[field]
  }
  return result
}

function defaultModelPricingResolver(
  providerId: string | undefined,
  modelId: string | undefined,
  opts: ResolvePricingOptions = {}
): Partial<ModelPricing> | null {
  if (!modelId) return null
  const layers: Array<Partial<ModelPricing> | undefined> = []
  if (providerId) {
    layers.push(
      opts.settings?.customProviders?.find((provider) => provider.id === providerId)
        ?.customModelMetadata?.[modelId]?.pricing
    )
    layers.push(
      opts.settings?.providerSettings?.[providerId]?.discoveredModels?.find(
        (model) => model.id === modelId
      )?.pricing
    )
    layers.push(getCatalogModelMetadata(providerId, modelId)?.pricing)
    layers.push(getModelConfig(providerId, modelId)?.pricing)
  }
  return mergePricingLayers(layers)
}

let modelPricingResolver: ModelPricingResolver = defaultModelPricingResolver

export function setModelPricingResolver(resolver: ModelPricingResolver): void {
  modelPricingResolver = resolver
}

export function resetModelPricingResolverForTesting(): void {
  modelPricingResolver = defaultModelPricingResolver
}

/** @deprecated alias — superseded by {@link PricingSettings}; kept for callers. */
export type PriceLookupSettings = PricingSettings

/**
 * Resolve pricing for a model id, falling through the reasoning-effort virtual
 * model form (`<base>-<effort>`, W3.3): a virtual id with no pricing of its own
 * inherits its base model's price (the user can still override the virtual id
 * independently via custom model metadata, which the direct lookup honours
 * first). Wired at the public entry points so it applies whether the default or
 * a host-injected resolver is active.
 */
function resolvePricingWithVirtual(
  providerId: string,
  modelId: string,
  options?: ResolvePricingOptions
): Partial<ModelPricing> | null {
  const direct = modelPricingResolver(providerId, modelId, options)
  if (direct) return direct
  const parsed = parseReasoningSuffix(modelId)
  if (!parsed) return null
  return modelPricingResolver(providerId, parsed.baseModel, options)
}

export function resolveModelPriceUsdPer1M(
  providerId: string,
  modelId: string,
  settings?: PriceLookupSettings
): number | undefined {
  // The resolver returns null unless at least one base rate is known, so a
  // non-null result always has a side to blend (a single-sided price is reused
  // for the absent side to keep the ranking figure comparable).
  const pricing = resolvePricingWithVirtual(providerId, modelId, { settings })
  if (!pricing) return undefined
  const inp = pricing.promptPer1M
  const out = pricing.completionPer1M
  if (inp !== undefined && out !== undefined) return (inp + out) / 2
  return inp ?? out
}

export interface EstimateCallCostInput {
  providerId: string
  modelId: string
  inputTokens: number
  outputTokens: number
  settings?: PriceLookupSettings
}

/**
 * Estimate the USD cost of one LLM call from split prompt/completion rates.
 * Unlike `resolveModelPriceUsdPer1M` (a blended *ranking* figure for the
 * routing engine), this prices the actual token mix. Returns undefined when
 * neither rate is known; a missing side is treated as 0 so partial pricing
 * still yields a lower-bound estimate. (Cache tokens are intentionally excluded
 * — routing prices on the input/output mix only.)
 */
export function estimateCallCostUsd(input: EstimateCallCostInput): number | undefined {
  const pricing = resolvePricingWithVirtual(input.providerId, input.modelId, {
    settings: input.settings,
  })
  if (!pricing) return undefined
  // A non-null result has ≥1 base rate; the absent side prices at 0 so partial
  // pricing still yields a lower-bound estimate.
  const prompt = pricing.promptPer1M ?? 0
  const completion = pricing.completionPer1M ?? 0
  return (
    (Math.max(0, input.inputTokens) * prompt) / 1_000_000 +
    (Math.max(0, input.outputTokens) * completion) / 1_000_000
  )
}
