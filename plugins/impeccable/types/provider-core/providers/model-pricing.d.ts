import { ModelPricing } from "@cognia/provider-types/provider"

/**
 * Resolve a comparable per-1M-token USD price for a provider:model, used by the
 * routing engine's cost-aware strategy. The package-local default keeps
 * provider-core independent from the app by reading custom metadata, discovered
 * models, the injected models.dev cache, and the built-in catalog. The host can
 * inject a richer resolver that also includes app-only legacy static tables.
 */
interface PricingSettings {
  providerSettings?: Record<
    string,
    | {
        discoveredModels?: Array<{
          id: string
          pricing?: Partial<ModelPricing>
        }>
      }
    | undefined
  >
  customProviders?: Array<{
    id: string
    customModelMetadata?: Record<
      string,
      | {
          pricing?: Partial<ModelPricing>
        }
      | undefined
    >
  }>
}
interface ResolvePricingOptions {
  settings?: PricingSettings
}
type ModelPricingResolver = (
  providerId: string | undefined,
  modelId: string | undefined,
  options?: ResolvePricingOptions
) => Partial<ModelPricing> | null
declare function mergePricingLayers(
  layers: Array<Partial<ModelPricing> | undefined>
): Partial<ModelPricing> | null
declare function setModelPricingResolver(resolver: ModelPricingResolver): void
declare function resetModelPricingResolverForTesting(): void
/** @deprecated alias — superseded by {@link PricingSettings}; kept for callers. */
type PriceLookupSettings = PricingSettings
declare function resolveModelPriceUsdPer1M(
  providerId: string,
  modelId: string,
  settings?: PriceLookupSettings
): number | undefined
interface EstimateCallCostInput {
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
declare function estimateCallCostUsd(input: EstimateCallCostInput): number | undefined

export {
  type EstimateCallCostInput,
  type ModelPricingResolver,
  type PriceLookupSettings,
  type PricingSettings,
  type ResolvePricingOptions,
  estimateCallCostUsd,
  mergePricingLayers,
  resetModelPricingResolverForTesting,
  resolveModelPriceUsdPer1M,
  setModelPricingResolver,
}
