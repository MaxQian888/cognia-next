/**
 * CLIProxyAPI Provider Integration
 * Self-hosted AI proxy aggregating multiple providers
 * https://help.router-for.me
 */
interface CLIProxyAPIConfig {
  host: string
  port: number
  apiKey: string
  managementKey?: string
}
interface CLIProxyAPIModel {
  id: string
  name: string
  provider?: string
  contextLength?: number
}
interface CLIProxyAPIServerInfo {
  version?: string
  uptime?: number
  models: CLIProxyAPIModel[]
}
interface CLIProxyAPIUsageStats {
  totalRequests: number
  totalTokens: number
  byModel: Record<
    string,
    {
      requests: number
      tokens: number
    }
  >
}
declare class CLIProxyAPIError extends Error {
  status?: number | undefined
  code?: string | undefined
  constructor(message: string, status?: number | undefined, code?: string | undefined)
}
/**
 * Get the base URL for CLIProxyAPI
 */
declare function getBaseURL(host?: string, port?: number): string
/**
 * Get the API URL for CLIProxyAPI
 */
declare function getAPIURL(host?: string, port?: number): string
/**
 * Get the WebUI URL for CLIProxyAPI
 */
declare function getWebUIURL(host?: string, port?: number): string
/**
 * Test connection to CLIProxyAPI server
 */
declare function testConnection(
  apiKey: string,
  host?: string,
  port?: number
): Promise<{
  success: boolean
  message: string
  latency?: number
}>
/**
 * Fetch available models from CLIProxyAPI server
 */
declare function fetchModels(
  apiKey: string,
  host?: string,
  port?: number
): Promise<CLIProxyAPIModel[]>
/**
 * Fetch server health status
 */
declare function fetchHealthStatus(
  host?: string,
  port?: number
): Promise<{
  healthy: boolean
  message: string
}>
/**
 * Fetch usage statistics (requires management key)
 */
declare function fetchUsageStats(
  managementKey: string,
  host?: string,
  port?: number
): Promise<CLIProxyAPIUsageStats | null>
/**
 * Check if WebUI is accessible
 */
declare function checkWebUIAccess(host?: string, port?: number): Promise<boolean>
/**
 * Format API key for display (mask middle portion)
 * Named differently from openrouter.ts to avoid export conflict
 */
declare function maskCLIProxyApiKey(apiKey: string): string
/**
 * Parse model ID to extract provider prefix if present
 * CLIProxyAPI supports format: "prefix/model-name"
 */
declare function parseCLIProxyModelId(modelId: string): {
  prefix?: string
  model: string
}
/**
 * Build model ID with optional prefix
 */
declare function buildModelId(model: string, prefix?: string): string
/**
 * Default CLIProxyAPI configuration
 */
declare const DEFAULT_CONFIG: CLIProxyAPIConfig
/**
 * Common model aliases used in CLIProxyAPI
 */
declare const COMMON_MODEL_ALIASES: Record<string, string>

export {
  type CLIProxyAPIConfig,
  CLIProxyAPIError,
  type CLIProxyAPIModel,
  type CLIProxyAPIServerInfo,
  type CLIProxyAPIUsageStats,
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
}
