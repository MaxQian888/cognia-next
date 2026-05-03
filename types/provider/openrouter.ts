/**
 * OpenRouter-specific type definitions
 * Supports OAuth, Provisioning API, and BYOK features
 * https://openrouter.ai/docs
 */

import type { BYOKKeyEntry } from "./provider"

// ============================================================================
// API Key Management Types (Provisioning API)
// https://openrouter.ai/docs/guides/overview/auth/provisioning-api-keys
// ============================================================================

export type LimitResetPeriod = "daily" | "weekly" | "monthly" | null

export interface OpenRouterApiKey {
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

export interface OpenRouterApiKeyCreate {
  name: string
  limit?: number
  limit_reset?: LimitResetPeriod
}

export interface OpenRouterApiKeyUpdate {
  name?: string
  disabled?: boolean
  limit?: number | null
  limit_reset?: LimitResetPeriod
  includeByokInLimit?: boolean
}

export interface OpenRouterApiKeyResponse {
  data: OpenRouterApiKey[]
}

export interface OpenRouterApiKeyCreateResponse {
  data: OpenRouterApiKey & {
    key: string // Full API key only returned on creation
  }
}

// ============================================================================
// BYOK (Bring Your Own Key) Types
// https://openrouter.ai/docs/guides/overview/auth/byok
// ============================================================================

// BYOKProvider is defined in provider.ts
import type { BYOKProvider } from "./provider"
export type { BYOKProvider }

type _BYOKProviderInternal = "azure" | "bedrock" | "vertex" | "mistral" | "cohere" | "groq"

// Azure BYOK configuration
export interface AzureBYOKConfig {
  model_slug: string
  endpoint_url: string
  api_key: string
  model_id: string
}

// AWS Bedrock BYOK - Option 1: API Key (recommended)
export type BedrockBYOKApiKey = string

// AWS Bedrock BYOK - Option 2: Credentials
export interface BedrockBYOKCredentials {
  accessKeyId: string
  secretAccessKey: string
  region: string
}

export type BedrockBYOKConfig = BedrockBYOKApiKey | BedrockBYOKCredentials

// Google Vertex BYOK configuration
export interface VertexBYOKConfig {
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

// Simple API key providers (OpenAI, Anthropic, Mistral, Cohere, Groq)
export type SimpleBYOKConfig = string

// Union type for all BYOK configurations
export type BYOKConfig =
  | SimpleBYOKConfig
  | AzureBYOKConfig
  | AzureBYOKConfig[]
  | BedrockBYOKConfig
  | VertexBYOKConfig

// Note: BYOKKeyEntry is defined in @/types/provider for use across the app
// This file contains the config types used within those entries

// ============================================================================
// Provider Ordering Types
// ============================================================================

export interface ProviderOrderingConfig {
  allow_fallbacks: boolean
  order: string[]
}

// ============================================================================
// Credits & Usage Types
// ============================================================================

export interface OpenRouterCredits {
  credits: number
  credits_used: number
  credits_remaining: number
  total_credits?: number
  total_usage?: number
}

export interface OpenRouterUsageEntry {
  id: string
  model: string
  provider: string
  tokens_prompt: number
  tokens_completion: number
  cost: number
  created_at: string
  is_byok: boolean
}

export interface OpenRouterUsageResponse {
  data: OpenRouterUsageEntry[]
  total_cost: number
  total_tokens: number
}

// ============================================================================
// Model Types
// ============================================================================

export interface OpenRouterModel {
  id: string
  name: string
  description?: string
  context_length: number
  pricing: {
    prompt: string // Cost per token (string format)
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

export interface OpenRouterModelsResponse {
  data: OpenRouterModel[]
}

// ============================================================================
// OpenRouter Provider Settings Extension
// ============================================================================

export interface OpenRouterProviderSettings {
  // Standard fields (from UserProviderSettings)
  providerId: "openrouter"
  apiKey?: string
  defaultModel: string
  enabled: boolean

  // OAuth state
  oauthConnected?: boolean
  oauthExpiresAt?: number

  // Provisioning API key (different from regular API key)
  provisioningApiKey?: string

  // BYOK configurations
  byokKeys?: BYOKKeyEntry[]

  // Provider ordering
  providerOrdering?: ProviderOrderingConfig

  // Cached credits info
  credits?: OpenRouterCredits
  creditsLastFetched?: number

  // Model list cache
  cachedModels?: OpenRouterModel[]
  modelsLastFetched?: number
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface OpenRouterChatRequest {
  model: string
  messages: Array<{
    role: "system" | "user" | "assistant"
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  }>
  temperature?: number
  max_tokens?: number
  top_p?: number
  stream?: boolean
  provider?: ProviderOrderingConfig
  transforms?: string[]
}

export interface OpenRouterErrorResponse {
  error: {
    code: number
    message: string
    metadata?: Record<string, unknown>
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

export function isAzureBYOKConfig(
  config: BYOKConfig
): config is AzureBYOKConfig | AzureBYOKConfig[] {
  if (Array.isArray(config)) {
    return config.length > 0 && "endpoint_url" in config[0]
  }
  return typeof config === "object" && "endpoint_url" in config
}

export function isBedrockCredentials(config: BYOKConfig): config is BedrockBYOKCredentials {
  return typeof config === "object" && "accessKeyId" in config && "secretAccessKey" in config
}

export function isVertexBYOKConfig(config: BYOKConfig): config is VertexBYOKConfig {
  return typeof config === "object" && "type" in config && config.type === "service_account"
}

export function isSimpleBYOKConfig(config: BYOKConfig): config is SimpleBYOKConfig {
  return typeof config === "string"
}

// BYOK provider display names
export const BYOK_PROVIDER_NAMES: Record<BYOKProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google AI",
  azure: "Azure AI Services",
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  mistral: "Mistral AI",
  cohere: "Cohere",
  groq: "Groq",
}

// Providers that support simple API key BYOK
export const SIMPLE_BYOK_PROVIDERS: BYOKProvider[] = [
  "openai",
  "anthropic",
  "mistral",
  "cohere",
  "groq",
]

// Providers that require complex configuration
export const COMPLEX_BYOK_PROVIDERS: BYOKProvider[] = ["azure", "bedrock", "vertex"]
