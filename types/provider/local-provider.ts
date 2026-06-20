// Re-export shim: canonical source moved to @cognia/provider-types (Stage 1).
export {
  LOCAL_PROVIDER_PORTS,
  LOCAL_PROVIDER_URLS,
  formatLocalModelSize,
  getOpenAICompatibleURL,
  isLocalProviderName,
} from "@cognia/provider-types/local-provider"
export type {
  LocalModelInfo,
  LocalModelPullProgress,
  LocalProviderFeatures,
  LocalProviderName,
  LocalProviderServer,
  LocalServerStatus,
} from "@cognia/provider-types/local-provider"
