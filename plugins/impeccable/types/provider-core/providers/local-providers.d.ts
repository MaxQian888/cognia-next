import { ProviderName } from "@cognia/provider-types"

/**
 * Local Provider Clients - OpenAI-compatible local inference engines
 *
 * All local providers use the OpenAI-compatible API, so they share common
 * patterns for connection testing, model listing, and server status checks.
 */

/**
 * Local provider configuration
 */
interface LocalProviderConfig {
  id: ProviderName
  name: string
  defaultPort: number
  defaultBaseURL: string
  modelsEndpoint: string
  healthEndpoint: string
  supportsModelList: boolean
  supportsEmbeddings: boolean
  description: string
  website: string
  icon?: string
}
/**
 * Local provider server status
 */
interface LocalProviderStatus {
  connected: boolean
  version?: string
  models_count?: number
  error?: string
}
/**
 * Local model info (generic for OpenAI-compatible APIs)
 */
interface LocalModel {
  id: string
  object?: string
  created?: number
  owned_by?: string
}
/**
 * Configuration for all supported local providers
 */
declare const LOCAL_PROVIDER_CONFIGS: Record<string, LocalProviderConfig>
/**
 * Get default base URL for a local provider from canonical type definitions.
 * Falls back to LOCAL_PROVIDER_CONFIGS if provider is unknown.
 */
declare function getDefaultLocalProviderUrl(providerId: ProviderName): string
/**
 * Get default port for a local provider from canonical type definitions.
 */
declare function getDefaultLocalProviderPort(providerId: ProviderName): number
/**
 * Normalize base URL - remove trailing slashes
 */
declare function normalizeBaseUrl(baseUrl: string): string
/**
 * Get local provider status (generic for OpenAI-compatible APIs)
 */
declare function getLocalProviderStatus(
  providerId: string,
  baseUrl?: string
): Promise<LocalProviderStatus>
/**
 * List models from a local provider (OpenAI-compatible /v1/models endpoint)
 */
declare function listLocalProviderModels(
  providerId: string,
  baseUrl?: string
): Promise<LocalModel[]>
/**
 * Test connection to a local provider
 */
declare function testLocalProviderConnection(
  providerId: string,
  baseUrl?: string
): Promise<{
  success: boolean
  message: string
  latency?: number
}>
/**
 * Get the default base URL for a local provider
 */
declare function getDefaultBaseURL(providerId: string): string
/**
 * Check if a provider is a local provider
 */
declare function isLocalProvider(providerId: string): boolean
/**
 * Get all local provider IDs
 */
declare function getLocalProviderIds(): string[]

export {
  LOCAL_PROVIDER_CONFIGS,
  type LocalModel,
  type LocalProviderConfig,
  type LocalProviderStatus,
  getDefaultBaseURL,
  getDefaultLocalProviderPort,
  getDefaultLocalProviderUrl,
  getLocalProviderIds,
  getLocalProviderStatus,
  isLocalProvider,
  listLocalProviderModels,
  normalizeBaseUrl,
  testLocalProviderConnection,
}
