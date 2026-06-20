// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  CLIProxyAPIError,
  COMMON_MODEL_ALIASES,
  DEFAULT_CONFIG,
  buildModelId,
  checkWebUIAccess,
  fetchHealthStatus,
  fetchModels,
  fetchUsageStats,
  getAPIURL,
  getBaseURL,
  getWebUIURL,
  maskCLIProxyApiKey,
  parseCLIProxyModelId,
  testConnection,
} from "@cognia/provider-core/providers/cliproxyapi"
export type {
  CLIProxyAPIConfig,
  CLIProxyAPIModel,
  CLIProxyAPIServerInfo,
  CLIProxyAPIUsageStats,
} from "@cognia/provider-core/providers/cliproxyapi"
