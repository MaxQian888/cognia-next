import {
  ProviderOrderingConfig,
  OpenRouterApiKeyCreate,
  OpenRouterApiKeyCreateResponse,
  OpenRouterUsageEntry,
  OpenRouterApiKey,
  OpenRouterCredits,
  OpenRouterModel,
  OpenRouterUsageResponse,
  OpenRouterApiKeyUpdate,
} from "@cognia/provider-types/openrouter"
import { BYOKKeyEntry } from "@cognia/provider-types"

/**
 * OpenRouter API Service
 * Provides methods for key management, credits, models, and BYOK
 * https://openrouter.ai/docs
 */

declare class OpenRouterError extends Error {
  code: number
  metadata?: Record<string, unknown>
  constructor(message: string, code: number, metadata?: Record<string, unknown>)
}
declare function listApiKeys(provisioningKey: string, offset?: number): Promise<OpenRouterApiKey[]>
declare function createApiKey(
  provisioningKey: string,
  config: OpenRouterApiKeyCreate
): Promise<OpenRouterApiKeyCreateResponse["data"]>
declare function getApiKey(provisioningKey: string, keyHash: string): Promise<OpenRouterApiKey>
declare function updateApiKey(
  provisioningKey: string,
  keyHash: string,
  updates: OpenRouterApiKeyUpdate
): Promise<OpenRouterApiKey>
declare function deleteApiKey(provisioningKey: string, keyHash: string): Promise<void>
declare function getCredits(apiKey: string): Promise<OpenRouterCredits>
interface UsageHistoryOptions {
  /** Number of entries to return (default: 100) */
  limit?: number
  /** Offset for pagination (default: 0) */
  offset?: number
}
/**
 * Get usage history for an API key
 * https://openrouter.ai/docs/api-reference/get-api-key-usage
 */
declare function getUsageHistory(
  apiKey: string,
  options?: UsageHistoryOptions
): Promise<OpenRouterUsageResponse>
/**
 * Get all usage entries by paginating through results
 */
declare function getAllUsageHistory(
  apiKey: string,
  maxEntries?: number
): Promise<OpenRouterUsageEntry[]>
declare function listModels(apiKey?: string): Promise<OpenRouterModel[]>
declare function getModel(modelId: string, apiKey?: string): Promise<OpenRouterModel | null>
declare function buildProviderOrderingHeader(
  byokKeys: BYOKKeyEntry[],
  ordering?: ProviderOrderingConfig
): ProviderOrderingConfig | undefined
declare function getEnabledBYOKProviders(byokKeys: BYOKKeyEntry[]): string[]
interface OpenRouterRequestConfig {
  apiKey: string
  model: string
  messages: Array<{
    role: "system" | "user" | "assistant"
    content: string
  }>
  temperature?: number
  maxTokens?: number
  topP?: number
  stream?: boolean
  providerOrdering?: ProviderOrderingConfig
  siteUrl?: string
  siteName?: string
}
declare function buildChatRequestHeaders(
  apiKey: string,
  siteUrl?: string,
  siteName?: string
): Record<string, string>
declare function buildChatRequestBody(config: OpenRouterRequestConfig): Record<string, unknown>
declare function isValidOpenRouterKey(key: string): boolean
declare function isProvisioningKey(key: string): boolean
declare function maskApiKey(key: string): string
declare function formatCredits(credits: number): string
declare function formatUsage(tokens: number): string
declare function parseModelPricing(model: OpenRouterModel): {
  promptPer1M: number
  completionPer1M: number
}
declare function isModelFree(model: OpenRouterModel): boolean
declare function getModelProvider(modelId: string): string
declare function sortModelsByProvider(models: OpenRouterModel[]): OpenRouterModel[]
declare function groupModelsByProvider(models: OpenRouterModel[]): Record<string, OpenRouterModel[]>

export {
  OpenRouterError,
  type OpenRouterRequestConfig,
  type UsageHistoryOptions,
  buildChatRequestBody,
  buildChatRequestHeaders,
  buildProviderOrderingHeader,
  createApiKey,
  deleteApiKey,
  formatCredits,
  formatUsage,
  getAllUsageHistory,
  getApiKey,
  getCredits,
  getEnabledBYOKProviders,
  getModel,
  getModelProvider,
  getUsageHistory,
  groupModelsByProvider,
  isModelFree,
  isProvisioningKey,
  isValidOpenRouterKey,
  listApiKeys,
  listModels,
  maskApiKey,
  parseModelPricing,
  sortModelsByProvider,
  updateApiKey,
}
