/**
 * Resolve a comparable per-1M-token USD price for a provider:model, used by the
 * routing engine's cost-aware strategy (ADR-0043 Phase 4). Delegates to the
 * unified resolver (`lib/usage/pricing.ts`) so the routing figure is sourced
 * from the SAME layered chain as the UI cost read-outs — user-curated custom
 * metadata, then remote-discovered models, then the synced models.dev catalog,
 * then the static tables, then the built-in catalog — and blends input/output
 * rates into one ranking figure. Returns undefined when no pricing is known
 * (the engine treats that as "no cost info").
 */

import { resolveModelPricingUsd, type PricingSettings } from "@/lib/usage/pricing"

/** @deprecated alias — superseded by {@link PricingSettings}; kept for callers. */
export type PriceLookupSettings = PricingSettings

export function resolveModelPriceUsdPer1M(
  providerId: string,
  modelId: string,
  settings?: PriceLookupSettings
): number | undefined {
  // resolveModelPricingUsd returns null unless ≥1 base rate is known, so a
  // non-null result always has a side to blend (a single-sided price is reused
  // for the absent side to keep the ranking figure comparable).
  const pricing = resolveModelPricingUsd(providerId, modelId, { settings })
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
  const pricing = resolveModelPricingUsd(input.providerId, input.modelId, {
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
