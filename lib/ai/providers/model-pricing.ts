/**
 * Resolve a comparable per-1M-token USD price for a provider:model, used by the
 * routing engine's cost-aware strategy (ADR-0043 Phase 4). Prefers the freshest
 * source — user-curated custom metadata, then remote-discovered models, then the
 * static built-in catalog — and blends input/output rates into one ranking
 * figure. Returns undefined when no pricing is known (the engine treats that as
 * "no cost info").
 */

import { getModelConfig, type ModelPricing } from "@/types/provider/provider"

export interface PriceLookupSettings {
  providerSettings?: Record<
    string,
    { discoveredModels?: Array<{ id: string; pricing?: Partial<ModelPricing> }> } | undefined
  >
  customProviders?: Array<{
    id: string
    customModelMetadata?: Record<string, { pricing?: Partial<ModelPricing> } | undefined>
  }>
}

function blend(pricing: Partial<ModelPricing> | undefined): number | undefined {
  if (!pricing) return undefined
  const inp = typeof pricing.promptPer1M === "number" ? pricing.promptPer1M : undefined
  const out = typeof pricing.completionPer1M === "number" ? pricing.completionPer1M : undefined
  if (inp === undefined && out === undefined) return undefined
  return ((inp ?? out ?? 0) + (out ?? inp ?? 0)) / 2
}

/** Freshest known pricing for a provider:model (custom > discovered > catalog). */
function resolvePricing(
  providerId: string,
  modelId: string,
  settings?: PriceLookupSettings
): Partial<ModelPricing> | undefined {
  const customPricing = settings?.customProviders?.find((p) => p.id === providerId)
    ?.customModelMetadata?.[modelId]?.pricing
  const discoveredPricing = settings?.providerSettings?.[providerId]?.discoveredModels?.find(
    (m) => m.id === modelId
  )?.pricing
  const catalogPricing = getModelConfig(providerId, modelId)?.pricing

  return customPricing ?? discoveredPricing ?? catalogPricing
}

export function resolveModelPriceUsdPer1M(
  providerId: string,
  modelId: string,
  settings?: PriceLookupSettings
): number | undefined {
  const customPricing = settings?.customProviders?.find((p) => p.id === providerId)
    ?.customModelMetadata?.[modelId]?.pricing
  const discoveredPricing = settings?.providerSettings?.[providerId]?.discoveredModels?.find(
    (m) => m.id === modelId
  )?.pricing
  const catalogPricing = getModelConfig(providerId, modelId)?.pricing

  return blend(customPricing) ?? blend(discoveredPricing) ?? blend(catalogPricing)
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
 * still yields a lower-bound estimate.
 */
export function estimateCallCostUsd(input: EstimateCallCostInput): number | undefined {
  const pricing = resolvePricing(input.providerId, input.modelId, input.settings)
  if (!pricing) return undefined
  const prompt = typeof pricing.promptPer1M === "number" ? pricing.promptPer1M : undefined
  const completion =
    typeof pricing.completionPer1M === "number" ? pricing.completionPer1M : undefined
  if (prompt === undefined && completion === undefined) return undefined
  return (
    (Math.max(0, input.inputTokens) * (prompt ?? 0)) / 1_000_000 +
    (Math.max(0, input.outputTokens) * (completion ?? 0)) / 1_000_000
  )
}
