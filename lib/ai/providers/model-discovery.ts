// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  buildBuiltInProviderModelDiscoverySnapshot,
  buildCustomProviderModelDiscoverySnapshot,
  buildProviderModelDiscoverySnapshot,
  discoverCLIProxyAPIModels,
  discoverLocalProviderModels,
  discoverOpenAICompatibleModels,
  discoverOpenRouterModels,
  mergePricing,
  modelConfigToProviderModelCandidate,
} from "@cognia/provider-core/providers/model-discovery"
export type {
  DiscoveredProviderModel,
  ProviderModelCandidate,
  ProviderModelDiscoverySnapshot,
  ProviderModelFreshness,
  ProviderModelSource,
} from "@cognia/provider-core/providers/model-discovery"
