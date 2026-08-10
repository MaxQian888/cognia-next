import { BYOKProvider, BYOKKeyEntry } from "./provider.js"
import "./built-in-provider-catalog.js"
import "./bedrock.js"

/**
 * OpenRouter-specific type definitions
 * Supports OAuth, Provisioning API, and BYOK features
 * https://openrouter.ai/docs
 */

type LimitResetPeriod = "daily" | "weekly" | "monthly" | null
interface OpenRouterApiKey {
  created_at: string
  updated_at: string
  hash: string
  label: string
  name: string
  disabled: boolean
  limit: number | null
  limit_remaining: number | null
  limit_reset: LimitResetPeriod
  include_byok_in_limit: boolean
  usage: number
  usage_daily: number
  usage_weekly: number
  usage_monthly: number
  byok_usage: number
  byok_usage_daily: number
  byok_usage_weekly: number
  byok_usage_monthly: number
}
interface OpenRouterApiKeyCreate {
  name: string
  limit?: number
  limit_reset?: LimitResetPeriod
}
interface OpenRouterApiKeyUpdate {
  name?: string
  disabled?: boolean
  limit?: number | null
  limit_reset?: LimitResetPeriod
  includeByokInLimit?: boolean
}
interface OpenRouterApiKeyResponse {
  data: OpenRouterApiKey[]
}
interface OpenRouterApiKeyCreateResponse {
  data: OpenRouterApiKey & {
    key: string
  }
}

interface AzureBYOKConfig {
  model_slug: string
  endpoint_url: string
  api_key: string
  model_id: string
}
type BedrockBYOKApiKey = string
interface BedrockBYOKCredentials {
  accessKeyId: string
  secretAccessKey: string
  region: string
}
type BedrockBYOKConfig = BedrockBYOKApiKey | BedrockBYOKCredentials
interface VertexBYOKConfig {
  type: "service_account"
  project_id: string
  private_key_id: string
  private_key: string
  client_email: string
  client_id: string
  auth_uri: string
  token_uri: string
  auth_provider_x509_cert_url: string
  client_x509_cert_url: string
  universe_domain: string
  region?: string
}
type SimpleBYOKConfig = string
type BYOKConfig =
  SimpleBYOKConfig | AzureBYOKConfig | AzureBYOKConfig[] | BedrockBYOKConfig | VertexBYOKConfig
interface ProviderOrderingConfig {
  allow_fallbacks: boolean
  order: string[]
}
interface OpenRouterCredits {
  credits: number
  credits_used: number
  credits_remaining: number
  total_credits?: number
  total_usage?: number
}
interface OpenRouterUsageEntry {
  id: string
  model: string
  provider: string
  tokens_prompt: number
  tokens_completion: number
  cost: number
  created_at: string
  is_byok: boolean
}
interface OpenRouterUsageResponse {
  data: OpenRouterUsageEntry[]
  total_cost: number
  total_tokens: number
}
interface OpenRouterModel {
  id: string
  name: string
  description?: string
  context_length: number
  pricing: {
    prompt: string
    completion: string
    image?: string
  }
  top_provider?: {
    max_completion_tokens?: number
    is_moderated?: boolean
  }
  per_request_limits?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
  architecture?: {
    modality: string
    tokenizer: string
    instruct_type?: string
  }
}
interface OpenRouterModelsResponse {
  data: OpenRouterModel[]
}
interface OpenRouterProviderSettings {
  providerId: "openrouter"
  apiKey?: string
  defaultModel: string
  enabled: boolean
  oauthConnected?: boolean
  oauthExpiresAt?: number
  provisioningApiKey?: string
  byokKeys?: BYOKKeyEntry[]
  providerOrdering?: ProviderOrderingConfig
  credits?: OpenRouterCredits
  creditsLastFetched?: number
  cachedModels?: OpenRouterModel[]
  modelsLastFetched?: number
}
interface OpenRouterChatRequest {
  model: string
  messages: Array<{
    role: "system" | "user" | "assistant"
    content:
      | string
      | Array<{
          type: string
          text?: string
          image_url?: {
            url: string
          }
        }>
  }>
  temperature?: number
  max_tokens?: number
  top_p?: number
  stream?: boolean
  provider?: ProviderOrderingConfig
  transforms?: string[]
}
interface OpenRouterErrorResponse {
  error: {
    code: number
    message: string
    metadata?: Record<string, unknown>
  }
}
declare function isAzureBYOKConfig(
  config: BYOKConfig
): config is AzureBYOKConfig | AzureBYOKConfig[]
declare function isBedrockCredentials(config: BYOKConfig): config is BedrockBYOKCredentials
declare function isVertexBYOKConfig(config: BYOKConfig): config is VertexBYOKConfig
declare function isSimpleBYOKConfig(config: BYOKConfig): config is SimpleBYOKConfig
declare const BYOK_PROVIDER_NAMES: Record<BYOKProvider, string>
declare const SIMPLE_BYOK_PROVIDERS: BYOKProvider[]
declare const COMPLEX_BYOK_PROVIDERS: BYOKProvider[]

export {
  type AzureBYOKConfig,
  type BYOKConfig,
  BYOKProvider,
  BYOK_PROVIDER_NAMES,
  type BedrockBYOKApiKey,
  type BedrockBYOKConfig,
  type BedrockBYOKCredentials,
  COMPLEX_BYOK_PROVIDERS,
  type LimitResetPeriod,
  type OpenRouterApiKey,
  type OpenRouterApiKeyCreate,
  type OpenRouterApiKeyCreateResponse,
  type OpenRouterApiKeyResponse,
  type OpenRouterApiKeyUpdate,
  type OpenRouterChatRequest,
  type OpenRouterCredits,
  type OpenRouterErrorResponse,
  type OpenRouterModel,
  type OpenRouterModelsResponse,
  type OpenRouterProviderSettings,
  type OpenRouterUsageEntry,
  type OpenRouterUsageResponse,
  type ProviderOrderingConfig,
  SIMPLE_BYOK_PROVIDERS,
  type SimpleBYOKConfig,
  type VertexBYOKConfig,
  isAzureBYOKConfig,
  isBedrockCredentials,
  isSimpleBYOKConfig,
  isVertexBYOKConfig,
}
