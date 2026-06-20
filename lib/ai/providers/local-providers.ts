// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  LOCAL_PROVIDER_CONFIGS,
  getDefaultBaseURL,
  getDefaultLocalProviderPort,
  getDefaultLocalProviderUrl,
  getLocalProviderIds,
  getLocalProviderStatus,
  isLocalProvider,
  listLocalProviderModels,
  normalizeBaseUrl,
  testLocalProviderConnection,
} from "@cognia/provider-core/providers/local-providers"
export type {
  LocalModel,
  LocalProviderConfig,
  LocalProviderStatus,
} from "@cognia/provider-core/providers/local-providers"
