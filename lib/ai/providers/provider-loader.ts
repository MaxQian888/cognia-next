// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  __resetProviderRegistryForTesting,
  getDynamicProviders,
  getProviderDefinition,
  listProviderDefinitions,
  registerProviderDefinition,
  unregisterProvider,
  unregisterProvidersBySource,
} from "@cognia/provider-core/providers/provider-loader"
export type {
  ProviderDefinition,
  ProviderModelDefinition,
  ProviderProtocol,
  ProviderSource,
  ProviderType,
} from "@cognia/provider-core/providers/provider-loader"
