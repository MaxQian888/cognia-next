/**
 * AI Provider type definitions
 */

import { getDynamicProviders } from "./dynamic-provider-registry"
import { getBuiltInProviderCatalog } from "./built-in-provider-catalog"
import type {
  BuiltInProviderId,
  BuiltInProviderCatalogEntry,
  BuiltInProviderModelEntry,
} from "./built-in-provider-catalog"
import type { BedrockConnectionSettings } from "./bedrock"

export type ProviderType = "cloud" | "local"

export type ProviderName = BuiltInProviderId | "auto"

/** Pricing tiers for a model, all denominated per 1 million tokens (USD). */
export interface ModelPricing {
  /** Standard input token price per 1M tokens. */
  promptPer1M: number
  /** Standard output token price per 1M tokens. */
  completionPer1M: number
  /** Price for reading cached input tokens (Anthropic, OpenAI, Google). */
  cachedInputPer1M?: number
  /** Price for writing/creating cache entries (Anthropic cache_creation). */
  cacheCreationPer1M?: number
  /** Batch API input price (OpenAI batch, Anthropic message batches). */
  batchInputPer1M?: number
  /** Batch API output price. */
  batchOutputPer1M?: number
  /** Audio input token price (OpenAI Whisper/Realtime, Google audio). */
  audioInputPer1M?: number
  /** Audio output token price. */
  audioOutputPer1M?: number
  /**
   * Currency of the pricing values.
   * Defaults to 'USD'. Chinese providers may specify 'CNY'.
   */
  currency?: "USD" | "CNY"
}

export interface ModelConfig {
  id: string
  name: string
  contextLength: number
  maxOutputTokens?: number
  supportsTools: boolean
  supportsVision: boolean
  supportsAudio: boolean
  supportsVideo: boolean
  supportsStreaming: boolean
  supportsReasoning?: boolean
  supportsImageGeneration?: boolean
  supportsEmbedding?: boolean
  pricing?: ModelPricing
}

export interface ProviderModelDiscoveryEntry {
  id: string
  name?: string
  provider?: string
  contextLength?: number
  maxOutputTokens?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsAudio?: boolean
  supportsVideo?: boolean
  supportsStreaming?: boolean
  supportsReasoning?: boolean
  supportsImageGeneration?: boolean
  supportsEmbedding?: boolean
  supportsStructuredOutput?: boolean
  pricing?: Partial<ModelPricing>
}

// Alias for component usage
export type Model = ModelConfig

export interface ProviderConfig {
  id: string
  name: string
  type: ProviderType
  apiKeyRequired: boolean
  baseURLRequired: boolean
  defaultBaseURL?: string
  protocol?: BuiltInApiProtocol
  /**
   * OpenAI endpoint family override (responses/chat/auto). Lets a provider opt
   * into the Responses API regardless of host (Azure, compatible gateways,
   * custom base URLs). Omitted = "auto" (host heuristic). See {@link ApiFlavor}.
   */
  apiFlavor?: ApiFlavor
  defaultEnabled?: boolean
  placeholderApiKey?: string
  models: ModelConfig[]
  defaultModel: string
  // OAuth support
  supportsOAuth?: boolean
  oauthConfig?: OAuthConfig
  // Provider metadata
  description?: string
  website?: string
  dashboardUrl?: string
  docsUrl?: string
  pricingUrl?: string
  category?: "flagship" | "aggregator" | "specialized" | "local" | "enterprise"
}

// OAuth configuration for providers that support it
export interface OAuthConfig {
  authorizationUrl: string
  tokenUrl: string
  clientId?: string
  scope?: string
  pkceRequired?: boolean
  callbackPath: string
  authorizationParams?: Record<string, OAuthRuleValue>
  callback?: OAuthCallbackConfig
  exchange?: OAuthExchangeConfig
}

export type OAuthRuleTransform = "to-string" | "to-number" | "to-boolean"

export interface OAuthValueFromRule {
  from: string
  transforms?: OAuthRuleTransform[]
}

export interface OAuthValueLiteralRule {
  literal: string | number | boolean | null
  transforms?: OAuthRuleTransform[]
}

export type OAuthRuleValue = OAuthValueFromRule | OAuthValueLiteralRule

export interface OAuthCallbackConfig {
  extract?: Record<string, string>
}

export interface OAuthExchangeConfig {
  method?: "GET" | "POST"
  headers?: Record<string, OAuthRuleValue>
  body?: Record<string, OAuthRuleValue>
  response?: Record<string, string>
}

// API Key rotation strategies
export type ApiKeyRotationStrategy = "round-robin" | "random" | "least-used"

// API Key usage statistics
export interface ApiKeyUsageStats {
  usageCount: number
  lastUsed: number
  errorCount: number
  lastError?: string
}

export type ProviderVerificationStatus = "unverified" | "verified" | "stale"

/** Provider-level inference parameter defaults (overrides global, overridden by session) */
export interface ProviderInferenceDefaults {
  temperature?: number
  maxTokens?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
}

/** Connection parameters for a provider */
export interface ProviderConnectionParams {
  /** Request timeout in ms (default 30000) */
  timeout?: number
  /** Max retry attempts (default 2) */
  maxRetries?: number
  /** Delay between retries in ms (default 1000) */
  retryDelay?: number
  /** Max concurrent requests (default unlimited) */
  concurrentLimit?: number
}

/**
 * AI SDK v6 call-option sampling parameters, in the SDK's own naming
 * (`maxOutputTokens`, not the legacy `maxTokens`). Produced by
 * `lib/ai/providers/inference-params.ts:buildModelInferenceParams` from a
 * provider's persisted `inferenceDefaults` / `connectionParams` /
 * `advancedParams`, attached to `SendOptions.modelParams`, and spread into
 * the sidecar's `streamText` call on the non-Anthropic path (ADR-0043).
 */
export interface ModelInferenceParams {
  temperature?: number
  maxOutputTokens?: number
  topP?: number
  topK?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
  stopSequences?: string[]
  maxRetries?: number
}

export interface UserProviderSettings {
  providerId: string
  apiKey?: string
  baseURL?: string
  /**
   * Extra static headers stamped on every request to this provider
   * (ADR-0090 Phase 1). Validated at write time by the shared transport
   * header policy (`transport-header-policy.ts`) — auth/hop-by-hop/internal
   * header names are rejected before they reach the store. Projected into
   * the derived TransportProfile's `staticHeaders`.
   */
  customHeaders?: Record<string, string>
  /**
   * ADR-0090 Phase 4 — EXPLICIT experimental opt-in: run this Anthropic-
   * protocol deployment through the Claude Agent SDK via the built-in
   * Gateway. Policy only — never a compatibility record, never written by
   * `auto`. Surfaced by the deployment-agent-sdk settings card behind the
   * `experimentalAnthropicDeploymentAgentSdk` feature flag.
   */
  experimentalAgentSdk?: boolean
  /** Native Amazon Bedrock authentication and region settings. */
  bedrock?: BedrockConnectionSettings
  /**
   * OpenAI endpoint family override (responses/chat/auto). Lets the user opt a
   * provider into the Responses API regardless of host — Azure OpenAI, a
   * compatible gateway that proxies `/responses`, or a custom base URL.
   * Omitted = "auto" (host heuristic). See {@link ApiFlavor}.
   */
  apiFlavor?: ApiFlavor
  /**
   * Wire protocol override (openai/anthropic/gemini/plugin id). Built-in
   * providers normally get a fixed protocol from the catalog (looked up by
   * provider id) — this lets the user override it for providers that sit
   * behind a proxy/relay speaking a different format than the catalog
   * assumes. Not offered for the literal `"anthropic"` provider id, which
   * always dispatches through the native Claude Agent SDK subprocess
   * regardless of this field (see `sidecar/dispatch/index.mjs`).
   */
  apiProtocol?: ApiProtocol
  defaultModel: string
  enabled: boolean
  discoveredModels?: ProviderModelDiscoveryEntry[]
  discoveredModelsLastFetched?: number
  // Model selection – whitelist of model IDs the user wants active.
  // undefined / empty = all models enabled (backwards compatible).
  enabledModels?: string[]
  // Multi-API Key support
  apiKeys?: string[]
  apiKeyRotationEnabled?: boolean
  apiKeyRotationStrategy?: ApiKeyRotationStrategy
  apiKeyUsageStats?: Record<string, ApiKeyUsageStats>
  currentKeyIndex?: number
  // OAuth state
  oauthConnected?: boolean
  oauthExpiresAt?: number
  // Verification lifecycle
  verificationStatus?: ProviderVerificationStatus
  lastVerifiedAt?: number
  verificationFingerprint?: string
  verificationMessage?: string
  // Health monitoring
  lastHealthCheck?: number
  healthStatus?: "healthy" | "degraded" | "error" | "unknown"
  quotaUsed?: number
  quotaLimit?: number
  rateLimitRemaining?: number
  // OpenRouter-specific settings
  openRouterSettings?: OpenRouterProviderSettings
  // CLIProxyAPI-specific settings
  cliProxyAPISettings?: CLIProxyAPIProviderSettings
  // Provider-specific parameter configuration
  /** Provider-level inference parameter defaults */
  inferenceDefaults?: ProviderInferenceDefaults
  /** Provider-specific parameters (e.g., reasoning_effort, thinking budget) */
  providerSpecificParams?: Record<string, unknown>
  /** Connection parameters */
  connectionParams?: ProviderConnectionParams
  /** Advanced parameters (response format, seed, etc.) */
  advancedParams?: Record<string, unknown>
}

// CLIProxyAPI-specific extended settings
export interface CLIProxyAPIProviderSettings {
  // Server configuration
  host?: string
  port?: number
  // Management API
  managementKey?: string
  allowRemoteManagement?: boolean
  // Routing strategy
  routingStrategy?: "round-robin" | "fill-first"
  // Request retry settings
  requestRetry?: number
  maxRetryInterval?: number
  // Quota exceeded behavior
  quotaExceededSwitchProject?: boolean
  quotaExceededSwitchPreviewModel?: boolean
  // Streaming settings
  streamingKeepaliveSeconds?: number
  streamingBootstrapRetries?: number
  // WebUI settings
  webUIEnabled?: boolean
  webUILastOpened?: number
  // Usage statistics
  usageStatisticsEnabled?: boolean
  // Connection status
  lastHealthCheck?: number
  connectionStatus?: "connected" | "disconnected" | "error"
  serverVersion?: string
  // Available models from server
  availableModels?: string[]
  modelsLastFetched?: number
}

// OpenRouter-specific extended settings
export interface OpenRouterProviderSettings {
  // Provisioning API key for key management
  provisioningApiKey?: string
  // BYOK (Bring Your Own Key) configurations
  byokKeys?: BYOKKeyEntry[]
  // Provider ordering for fallback control
  providerOrdering?: {
    enabled: boolean
    allowFallbacks: boolean
    order: string[]
  }
  // Cached credits info
  credits?: number
  creditsUsed?: number
  creditsRemaining?: number
  creditsLastFetched?: number
  // Cached models info
  modelsLastFetched?: number
  // Site attribution
  siteUrl?: string
  siteName?: string
}

// BYOK key entry for OpenRouter
export interface BYOKKeyEntry {
  id: string
  provider: BYOKProvider
  config: string // JSON stringified config for complex providers
  alwaysUse: boolean
  enabled: boolean
  name?: string
}

export type BYOKProvider =
  "openai" | "anthropic" | "google" | "azure" | "bedrock" | "vertex" | "mistral" | "cohere" | "groq"

/**
 * The three protocols custom providers can speak out of the box.
 * - openai: OpenAI-compatible API (most common, used by many providers)
 * - anthropic: Anthropic Claude API format
 * - gemini: Google Gemini API format
 */
export type BuiltInApiProtocol = "openai" | "anthropic" | "gemini" | "bedrock"

/** The built-in protocols, for pickers and exhaustive iteration. */
export const BUILTIN_API_PROTOCOLS: readonly BuiltInApiProtocol[] = [
  "openai",
  "anthropic",
  "gemini",
  "bedrock",
]

/**
 * API Protocol for custom providers — one of the built-ins or a
 * plugin-contributed protocol-adapter id (`${pluginId}:${id}`, resolved via
 * `lib/ai/providers/protocol-adapter-registry`). `(string & {})` keeps
 * literal autocompletion while accepting registered custom ids.
 */
export type ApiProtocol = BuiltInApiProtocol | (string & {})

/**
 * The execution-layer protocol namespace (what actually reaches AI SDK
 * dispatch). Distinct from the renderer-facing {@link ApiProtocol}, which names
 * Google's family `gemini`; here it is `google`, plus `mistral`/`cohere` (which
 * have no custom-provider picker entry but are dispatchable). The
 * renderer→execution bridge is `normalizeProtocol` in
 * `sidecar/dispatch/protocol-adapters/provider-protocol.mjs` (gemini → google),
 * guarded by `protocol-adapter-spec.parity.test.ts`. Defined here so the two
 * resolvers (`lib/ai/provider-consumption.ts`,
 * `packages/provider-core/.../provider-persistence.ts`) share one definition.
 */
export type ResolverProtocol =
  "openai" | "anthropic" | "google" | "mistral" | "cohere" | "azure" | "bedrock" | (string & {})

/**
 * OpenAI endpoint family selection. "responses"/"chat" override the host
 * heuristic — this is what unlocks the Responses API on Azure OpenAI, on
 * compatible gateways that proxy `/responses`, and on custom base URLs. "auto"
 * (or undefined) falls back to the heuristic in
 * `decideOpenAiEndpointFlavor` (provider-protocol.mjs).
 */
export type ApiFlavor = "auto" | "responses" | "chat"

/**
 * Per-model capability/pricing overrides for a custom provider. Mirrors
 * Cognia's `CustomModelMetadata`. Persisted on the parent
 * `CustomProviderSettings.customModelMetadata` map keyed by model id.
 */
export interface CustomModelMetadata {
  id: string
  name?: string
  contextLength?: number
  maxOutputTokens?: number
  /**
   * Per-model pricing override (USD per 1M tokens). Full {@link ModelPricing}
   * so a user can declare cache/batch rates too — the unified resolver
   * (`lib/usage/pricing.ts`) merges them ahead of the catalog, and without the
   * cache fields a cached-heavy custom model would otherwise fall back to the
   * Anthropic multiplier estimate.
   */
  pricing?: Partial<ModelPricing>
  capabilities?: {
    vision?: boolean
    functionCalling?: boolean
    streaming?: boolean
  }
}

export interface CustomProviderSettings extends UserProviderSettings {
  /** Stable id (also used as `providerId`). cognia-next stores customs as
   *  an array, so this is the lookup key components and the resolver use. */
  id: string
  /** Discriminator: distinguishes custom rows from built-in rows in stores
   *  that hold both. */
  isCustom: true
  /** User-facing display name, separate from `providerId`. */
  customName: string
  /** User-managed list of model ids for this provider. */
  customModels: string[]
  /** Optional per-model metadata (context length, pricing, capability flags). */
  customModelMetadata?: Record<string, CustomModelMetadata>
  /** Wire protocol — chooses the API adapter family for chat / model list. */
  apiProtocol: ApiProtocol
  /** Base URL is required for custom providers (the whole point). */
  baseURL: string
  /** Display name for this custom provider (alias of `customName`). */
  name: string
  /**  Convenience alias kept for components that read `models` directly
   *   (mirrors `customModels`). Stored separately so the type remains
   *   structurally compatible with Cognia's UI components. */
  models: string[]
}

/**
 * Per-(provider:model) usage entry for the cost tab. Persisted as a
 * flat list under `AppSettings.providerUsageStats`.
 */
export interface ProviderModelUsageEntry {
  /** ISO timestamp of the call. */
  at: string
  modelId: string
  promptTokens: number
  completionTokens: number
  /** Estimated cost in the `pricing.currency` of the model (default USD). */
  estimatedCost: number
  /** Whether the call succeeded; failed calls still count toward usage. */
  ok: boolean
}

/** UI state for the providers settings page (sidebar filters / view mode). */
export interface ProviderUIPreferences {
  /** Last provider opened in the settings detail pane. */
  selectedProviderId?: string
  /** Filter by status badge in the sidebar. */
  statusFilter?: "all" | "connected" | "error" | "not-configured"
  /** Filter by category from the catalog (flagship / aggregator / local / …). */
  categoryFilter?: string
  /** Sort order for the sidebar list. */
  sortBy?: "name" | "status" | "lastUsed"
  /**
   * @deprecated Selection of the retired provider-level compare dialog. Kept
   * only so persisted rows keep parsing; nothing reads or writes it. Use
   * {@link ProviderUIPreferences.comparisonModelKeys}.
   */
  comparisonProviderIds?: string[]
  /**
   * Model comparison selection, as `${providerId}:${modelId}` keys (max 4).
   * Restored when the compare pane reopens.
   */
  comparisonModelKeys?: string[]
  /** Sidebar (provider rail) width in px, set by the drag handle. */
  sidebarWidth?: number
}

/**
 * Curated, hand-authored provider definitions.
 *
 * These carry richer model metadata (pricing, capability flags, OAuth config)
 * than the catalog. On id collision, {@link buildBuiltInProviders} keeps this
 * richer UI metadata and legacy model history while taking the catalog's
 * current default and model entries as the source of truth.
 */
const INLINE_PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "gpt-4.1",
    models: [
      // GPT-5.4 family (Apr 2026)
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 2.5, completionPer1M: 15 },
      },
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.75, completionPer1M: 4.5 },
      },
      {
        id: "gpt-5.4-nano",
        name: "GPT-5.4 Nano",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.2, completionPer1M: 1.25 },
      },
      // GPT-4.1 family
      {
        id: "gpt-4.1",
        name: "GPT-4.1",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 2, completionPer1M: 8 },
      },
      {
        id: "gpt-4.1-mini",
        name: "GPT-4.1 Mini",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.4, completionPer1M: 1.6 },
      },
      {
        id: "gpt-4.1-nano",
        name: "GPT-4.1 Nano",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.1, completionPer1M: 0.4 },
      },
      // GPT-4o family
      {
        id: "gpt-4o",
        name: "GPT-4o",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 2.5, completionPer1M: 10 },
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.15, completionPer1M: 0.6 },
      },
      // o-series reasoning
      {
        id: "o3",
        name: "o3",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        supportsReasoning: true,
        pricing: { promptPer1M: 2, completionPer1M: 8 },
      },
      {
        id: "o4-mini",
        name: "o4 Mini",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        supportsReasoning: true,
        pricing: { promptPer1M: 1.1, completionPer1M: 4.4 },
      },
      {
        id: "o1",
        name: "o1",
        contextLength: 200000,
        supportsTools: false,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        supportsReasoning: true,
        pricing: { promptPer1M: 15, completionPer1M: 60 },
      },
    ],
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "claude-sonnet-4-6",
    models: [
      // Claude Opus 4.8 (latest flagship) — 1M context at standard pricing.
      {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        supportsReasoning: true,
        pricing: { promptPer1M: 5, completionPer1M: 25 },
      },
      {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        supportsReasoning: true,
        pricing: { promptPer1M: 5, completionPer1M: 25 },
      },
      // Claude 4.6 — 1M context tier.
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        supportsReasoning: true,
        pricing: { promptPer1M: 3, completionPer1M: 15 },
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        supportsReasoning: true,
        pricing: { promptPer1M: 5, completionPer1M: 25 },
      },
      // Claude 4.5
      {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 1, completionPer1M: 5 },
      },
      // Claude 4 (legacy)
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 3, completionPer1M: 15 },
      },
      {
        id: "claude-opus-4-20250514",
        name: "Claude Opus 4",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 15, completionPer1M: 75 },
      },
      // Claude 3 (legacy)
      {
        id: "claude-3-haiku-20240307",
        name: "Claude 3 Haiku",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.25, completionPer1M: 1.25 },
      },
    ],
  },
  google: {
    id: "google",
    name: "Google AI",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "gemini-2.5-flash",
    models: [
      // Gemini 3 (latest preview)
      {
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: true,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.5, completionPer1M: 3 },
      },
      // Gemini 2.5
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: true,
        supportsStreaming: true,
        supportsReasoning: true,
        pricing: { promptPer1M: 1.25, completionPer1M: 10 },
      },
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: true,
        supportsStreaming: true,
        supportsReasoning: true,
        pricing: { promptPer1M: 0.3, completionPer1M: 2.5 },
      },
      {
        id: "gemini-2.5-flash-lite",
        name: "Gemini 2.5 Flash-Lite",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: true,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.1, completionPer1M: 0.4 },
      },
      // Gemini 2.0 (deprecated Jun 2026)
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: true,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.1, completionPer1M: 0.4 },
      },
    ],
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "deepseek-v4-flash",
    models: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextLength: 1048576,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.14, completionPer1M: 0.28 },
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        contextLength: 1048576,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 1.74, completionPer1M: 3.48 },
      },
      {
        id: "deepseek-chat",
        name: "DeepSeek Chat (Legacy)",
        contextLength: 1048576,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.14, completionPer1M: 0.28 },
      },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner (Legacy)",
        contextLength: 1048576,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.14, completionPer1M: 0.28 },
      },
    ],
  },
  zhipu: {
    id: "zhipu",
    name: "Zhipu AI (智谱清言)",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "glm-4.7-flash",
    category: "specialized",
    description: "GLM models with strong Chinese and coding-oriented options",
    website: "https://open.bigmodel.cn",
    docsUrl: "https://open.bigmodel.cn/dev/howuse/introduction",
    dashboardUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    models: [
      // Free models
      {
        id: "glm-4.7-flash",
        name: "GLM-4.7 Flash",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0, completionPer1M: 0 },
      },
      {
        id: "glm-4-flash-250414",
        name: "GLM-4 Flash (250414)",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0, completionPer1M: 0 },
      },
      // Paid models
      {
        id: "glm-5",
        name: "GLM-5",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 100, completionPer1M: 100 },
      },
      {
        id: "glm-5-turbo",
        name: "GLM-5 Turbo",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 50, completionPer1M: 50 },
      },
      {
        id: "glm-4.7",
        name: "GLM-4.7",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 15, completionPer1M: 15 },
      },
      {
        id: "glm-4.7-flashx",
        name: "GLM-4.7 FlashX",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 3, completionPer1M: 3 },
      },
      {
        id: "glm-4.6",
        name: "GLM-4.6",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 3.5, completionPer1M: 14 },
      },
      {
        id: "glm-4.5-air",
        name: "GLM-4.5 Air",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 1, completionPer1M: 1 },
      },
      {
        id: "glm-4.5-airx",
        name: "GLM-4.5 AirX",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 2, completionPer1M: 2 },
      },
      {
        id: "glm-4-long",
        name: "GLM-4 Long",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 1, completionPer1M: 1 },
      },
      {
        id: "glm-4-flashx-250414",
        name: "GLM-4 FlashX (250414)",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.3, completionPer1M: 0.3 },
      },
      // Vision models
      {
        id: "glm-5v-turbo",
        name: "GLM-5V Turbo",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 50, completionPer1M: 50 },
      },
      {
        id: "glm-4.6v",
        name: "GLM-4.6V",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 10, completionPer1M: 10 },
      },
      {
        id: "glm-4.6v-flash",
        name: "GLM-4.6V Flash",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0, completionPer1M: 0 },
      },
    ],
  },
  minimax: {
    id: "minimax",
    name: "MiniMax",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "MiniMax-M2.7",
    category: "specialized",
    description:
      "MiniMax M2 series multimodal models. Supports both pay-as-you-go and Token Plan subscription keys.",
    website: "https://www.minimaxi.com",
    docsUrl: "https://platform.minimaxi.com/docs/api-reference/api-overview",
    dashboardUrl: "https://platform.minimaxi.com",
    models: [
      {
        id: "MiniMax-M2.7",
        name: "MiniMax M2.7",
        contextLength: 204800,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.3, completionPer1M: 1.2 },
      },
      {
        id: "MiniMax-M2.7-highspeed",
        name: "MiniMax M2.7 Highspeed",
        contextLength: 204800,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.3, completionPer1M: 1.2 },
      },
      {
        id: "MiniMax-M2.5",
        name: "MiniMax M2.5",
        contextLength: 204800,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.15, completionPer1M: 1.2 },
      },
      {
        id: "MiniMax-M2.5-highspeed",
        name: "MiniMax M2.5 Highspeed",
        contextLength: 204800,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.3, completionPer1M: 2.4 },
      },
      {
        id: "MiniMax-M2.1",
        name: "MiniMax M2.1",
        contextLength: 204800,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.27, completionPer1M: 0.95 },
      },
      {
        id: "MiniMax-M2.1-highspeed",
        name: "MiniMax M2.1 Highspeed",
        contextLength: 204800,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.27, completionPer1M: 0.95 },
      },
      {
        id: "MiniMax-M2",
        name: "MiniMax M2",
        contextLength: 204800,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.255, completionPer1M: 1.0 },
      },
    ],
  },
  groq: {
    id: "groq",
    name: "Groq",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "llama-3.3-70b-versatile",
    models: [
      {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.59, completionPer1M: 0.79 },
      },
      {
        id: "mixtral-8x7b-32768",
        name: "Mixtral 8x7B",
        contextLength: 32768,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.24, completionPer1M: 0.24 },
      },
    ],
  },
  mistral: {
    id: "mistral",
    name: "Mistral AI",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "mistral-large-latest",
    models: [
      {
        id: "mistral-large-latest",
        name: "Mistral Large",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 2, completionPer1M: 6 },
      },
      {
        id: "mistral-small-latest",
        name: "Mistral Small",
        contextLength: 32000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.2, completionPer1M: 0.6 },
      },
    ],
  },
  ollama: {
    id: "ollama",
    name: "Ollama (Local)",
    type: "local",
    apiKeyRequired: false,
    baseURLRequired: true,
    defaultModel: "llama3.2",
    category: "local",
    description: "Run models locally with easy model management",
    website: "https://ollama.ai",
    docsUrl: "https://github.com/ollama/ollama",
    models: [
      {
        id: "llama3.2",
        name: "Llama 3.2",
        contextLength: 8192,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
      {
        id: "qwen2.5",
        name: "Qwen 2.5",
        contextLength: 32000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
      {
        id: "mistral",
        name: "Mistral",
        contextLength: 32000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ],
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    type: "local",
    apiKeyRequired: false,
    baseURLRequired: true,
    defaultModel: "local-model",
    category: "local",
    description: "Desktop app for running local LLMs with OpenAI-compatible API",
    website: "https://lmstudio.ai",
    docsUrl: "https://lmstudio.ai/docs",
    models: [
      {
        id: "local-model",
        name: "Local Model",
        contextLength: 8192,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ],
  },
  llamacpp: {
    id: "llamacpp",
    name: "llama.cpp Server",
    type: "local",
    apiKeyRequired: false,
    baseURLRequired: true,
    defaultModel: "local-model",
    category: "local",
    description: "High-performance C++ inference server for GGUF models",
    website: "https://github.com/ggerganov/llama.cpp",
    docsUrl: "https://github.com/ggerganov/llama.cpp/blob/master/examples/server/README.md",
    models: [
      {
        id: "local-model",
        name: "Local Model",
        contextLength: 8192,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ],
  },
  llamafile: {
    id: "llamafile",
    name: "llamafile",
    type: "local",
    apiKeyRequired: false,
    baseURLRequired: true,
    defaultModel: "local-model",
    category: "local",
    description: "Single-file executable LLM with built-in server",
    website: "https://github.com/Mozilla-Ocho/llamafile",
    docsUrl: "https://github.com/Mozilla-Ocho/llamafile#readme",
    models: [
      {
        id: "local-model",
        name: "Local Model",
        contextLength: 8192,
        supportsTools: false,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ],
  },
  vllm: {
    id: "vllm",
    name: "vLLM",
    type: "local",
    apiKeyRequired: false,
    baseURLRequired: true,
    defaultModel: "local-model",
    category: "local",
    description: "High-throughput GPU inference engine with PagedAttention",
    website: "https://vllm.ai",
    docsUrl: "https://docs.vllm.ai",
    models: [
      {
        id: "local-model",
        name: "Local Model",
        contextLength: 32768,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ],
  },
  localai: {
    id: "localai",
    name: "LocalAI",
    type: "local",
    apiKeyRequired: false,
    baseURLRequired: true,
    defaultModel: "local-model",
    category: "local",
    description: "Self-hosted OpenAI alternative with multiple backends",
    website: "https://localai.io",
    docsUrl: "https://localai.io/docs",
    models: [
      {
        id: "local-model",
        name: "Local Model",
        contextLength: 8192,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ],
  },
  jan: {
    id: "jan",
    name: "Jan",
    type: "local",
    apiKeyRequired: false,
    baseURLRequired: true,
    defaultModel: "local-model",
    category: "local",
    description: "Open-source ChatGPT alternative with local-first design",
    website: "https://jan.ai",
    docsUrl: "https://jan.ai/docs",
    models: [
      {
        id: "local-model",
        name: "Local Model",
        contextLength: 8192,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ],
  },
  textgenwebui: {
    id: "textgenwebui",
    name: "Text Generation WebUI",
    type: "local",
    apiKeyRequired: false,
    baseURLRequired: true,
    defaultModel: "local-model",
    category: "local",
    description: "Gradio web UI with OpenAI-compatible API extension",
    website: "https://github.com/oobabooga/text-generation-webui",
    docsUrl: "https://github.com/oobabooga/text-generation-webui/wiki",
    models: [
      {
        id: "local-model",
        name: "Local Model",
        contextLength: 8192,
        supportsTools: false,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ],
  },
  koboldcpp: {
    id: "koboldcpp",
    name: "KoboldCpp",
    type: "local",
    apiKeyRequired: false,
    baseURLRequired: true,
    defaultModel: "local-model",
    category: "local",
    description: "Easy-to-use llama.cpp fork with web UI and API",
    website: "https://github.com/LostRuins/koboldcpp",
    docsUrl: "https://github.com/LostRuins/koboldcpp/wiki",
    models: [
      {
        id: "local-model",
        name: "Local Model",
        contextLength: 8192,
        supportsTools: false,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ],
  },
  tabbyapi: {
    id: "tabbyapi",
    name: "TabbyAPI",
    type: "local",
    apiKeyRequired: false,
    baseURLRequired: true,
    defaultModel: "local-model",
    category: "local",
    description: "Exllamav2 API server with OpenAI-compatible endpoints",
    website: "https://github.com/theroyallab/tabbyAPI",
    docsUrl: "https://github.com/theroyallab/tabbyAPI/wiki",
    models: [
      {
        id: "local-model",
        name: "Local Model",
        contextLength: 16384,
        supportsTools: false,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ],
  },
  xai: {
    id: "xai",
    name: "xAI (Grok)",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "grok-3",
    models: [
      {
        id: "grok-3",
        name: "Grok 3",
        contextLength: 131072,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 3, completionPer1M: 15 },
      },
      {
        id: "grok-3-mini",
        name: "Grok 3 Mini",
        contextLength: 131072,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.3, completionPer1M: 0.5 },
      },
    ],
  },
  togetherai: {
    id: "togetherai",
    name: "Together AI",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    category: "specialized",
    description: "Fast inference for open source models",
    website: "https://together.ai",
    dashboardUrl: "https://api.together.xyz/settings/api-keys",
    docsUrl: "https://docs.together.ai",
    models: [
      {
        id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        name: "Llama 3.3 70B Turbo",
        contextLength: 131072,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.88, completionPer1M: 0.88 },
      },
      {
        id: "Qwen/Qwen2.5-72B-Instruct-Turbo",
        name: "Qwen 2.5 72B Turbo",
        contextLength: 32768,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 1.2, completionPer1M: 1.2 },
      },
      {
        id: "deepseek-ai/DeepSeek-V3",
        name: "DeepSeek V3",
        contextLength: 65536,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.5, completionPer1M: 0.5 },
      },
    ],
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "anthropic/claude-sonnet-4",
    category: "aggregator",
    description: "Access 200+ models through one API with OAuth login",
    website: "https://openrouter.ai",
    dashboardUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    supportsOAuth: true,
    oauthConfig: {
      authorizationUrl: "https://openrouter.ai/auth",
      tokenUrl: "https://openrouter.ai/api/v1/auth/keys",
      pkceRequired: true,
      callbackPath: "/api/oauth/openrouter/callback",
      scope: "openid profile",
    },
    models: [
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 3, completionPer1M: 15 },
      },
      {
        id: "openai/gpt-4o",
        name: "GPT-4o",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 2.5, completionPer1M: 10 },
      },
      {
        id: "google/gemini-2.0-flash-exp:free",
        name: "Gemini 2.0 Flash (Free)",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: true,
        supportsStreaming: true,
        pricing: { promptPer1M: 0, completionPer1M: 0 },
      },
      {
        id: "meta-llama/llama-3.3-70b-instruct",
        name: "Llama 3.3 70B",
        contextLength: 131072,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.4, completionPer1M: 0.4 },
      },
      {
        id: "deepseek/deepseek-chat",
        name: "DeepSeek Chat",
        contextLength: 64000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.14, completionPer1M: 0.28 },
      },
      {
        id: "qwen/qwen-2.5-72b-instruct",
        name: "Qwen 2.5 72B",
        contextLength: 131072,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.35, completionPer1M: 0.4 },
      },
    ],
  },
  // OpenCode managed plans (ADR-0025) — OpenAI-compatible gateway; curated
  // fallback lists for the model picker (live /models discovery supersedes).
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "claude-sonnet-4-6",
    category: "aggregator",
    description: "OpenCode Zen — pay-per-request gateway to curated coding models",
    website: "https://opencode.ai/zen",
    dashboardUrl: "https://opencode.ai/auth",
    docsUrl: "https://opencode.ai/docs/zen/",
    models: [
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 3, completionPer1M: 15 },
      },
      {
        id: "gpt-5.2",
        name: "GPT-5.2",
        contextLength: 400000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 1.75, completionPer1M: 14 },
      },
      {
        id: "gemini-3-flash",
        name: "Gemini 3 Flash",
        contextLength: 1048576,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: true,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.5, completionPer1M: 3 },
      },
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        contextLength: 262144,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: true,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.95, completionPer1M: 4 },
      },
      {
        id: "glm-4.7",
        name: "GLM-4.7",
        contextLength: 204800,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.6, completionPer1M: 2.2 },
      },
      {
        id: "qwen3.5-plus",
        name: "Qwen3.5 Plus",
        contextLength: 262144,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: true,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.2, completionPer1M: 1.2 },
      },
    ],
  },
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "kimi-k2.6",
    category: "aggregator",
    description: "OpenCode Go — flat-rate subscription for open coding models",
    website: "https://opencode.ai/go",
    dashboardUrl: "https://opencode.ai/auth",
    docsUrl: "https://opencode.ai/docs/go/",
    models: [
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        contextLength: 262144,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: true,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.95, completionPer1M: 4 },
      },
      {
        id: "glm-5.1",
        name: "GLM-5.1",
        contextLength: 202752,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 1.4, completionPer1M: 4.4 },
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 1.74, completionPer1M: 3.48 },
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.14, completionPer1M: 0.28 },
      },
      {
        id: "qwen3.7-max",
        name: "Qwen3.7 Max",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 2.5, completionPer1M: 7.5 },
      },
      {
        id: "minimax-m3",
        name: "MiniMax M3",
        contextLength: 204800,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.3, completionPer1M: 1.2 },
      },
      {
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro",
        contextLength: 1048576,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 1.74, completionPer1M: 3.48 },
      },
    ],
  },
  // `codex` is intentionally NOT inlined here: it is defined once in the
  // built-in catalog, which carries the fields this map has no slot for
  // (protocol + defaultBaseURL). An inline copy would shadow the catalog
  // entry wholesale — see {@link buildBuiltInProviders} — and silently drop
  // both, so the model list must be edited in the catalog only.
  cohere: {
    id: "cohere",
    name: "Cohere",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "command-r-plus",
    category: "enterprise",
    description: "Enterprise AI with RAG and embeddings",
    website: "https://cohere.com",
    dashboardUrl: "https://dashboard.cohere.com/api-keys",
    docsUrl: "https://docs.cohere.com",
    models: [
      {
        id: "command-r-plus",
        name: "Command R+",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 2.5, completionPer1M: 10 },
      },
      {
        id: "command-r",
        name: "Command R",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.15, completionPer1M: 0.6 },
      },
      {
        id: "command-a-03-2025",
        name: "Command A",
        contextLength: 256000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 2.5, completionPer1M: 10 },
      },
    ],
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks AI",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    category: "specialized",
    description: "Ultra-fast inference with compound AI",
    website: "https://fireworks.ai",
    dashboardUrl: "https://fireworks.ai/account/api-keys",
    docsUrl: "https://docs.fireworks.ai",
    models: [
      {
        id: "accounts/fireworks/models/llama-v3p3-70b-instruct",
        name: "Llama 3.3 70B",
        contextLength: 131072,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.9, completionPer1M: 0.9 },
      },
      {
        id: "accounts/fireworks/models/qwen2p5-72b-instruct",
        name: "Qwen 2.5 72B",
        contextLength: 32768,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.9, completionPer1M: 0.9 },
      },
      {
        id: "accounts/fireworks/models/deepseek-v3",
        name: "DeepSeek V3",
        contextLength: 65536,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.9, completionPer1M: 0.9 },
      },
    ],
  },
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "llama-3.3-70b",
    category: "specialized",
    description: "Fastest inference with custom AI chips",
    website: "https://cerebras.ai",
    dashboardUrl: "https://cloud.cerebras.ai/platform",
    docsUrl: "https://inference-docs.cerebras.ai",
    models: [
      {
        id: "llama-3.3-70b",
        name: "Llama 3.3 70B",
        contextLength: 8192,
        supportsTools: false,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.85, completionPer1M: 1.2 },
      },
      {
        id: "llama-3.1-8b",
        name: "Llama 3.1 8B",
        contextLength: 8192,
        supportsTools: false,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0.1, completionPer1M: 0.1 },
      },
    ],
  },
  sambanova: {
    id: "sambanova",
    name: "SambaNova",
    type: "cloud",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "Meta-Llama-3.3-70B-Instruct",
    category: "specialized",
    description: "Enterprise AI with custom hardware",
    website: "https://sambanova.ai",
    dashboardUrl: "https://cloud.sambanova.ai/apis",
    docsUrl: "https://docs.sambanova.ai",
    models: [
      {
        id: "Meta-Llama-3.3-70B-Instruct",
        name: "Llama 3.3 70B",
        contextLength: 8192,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0, completionPer1M: 0 }, // Free tier available
      },
      {
        id: "DeepSeek-R1-Distill-Llama-70B",
        name: "DeepSeek R1 Distill 70B",
        contextLength: 8192,
        supportsTools: false,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0, completionPer1M: 0 },
      },
      {
        id: "Qwen2.5-72B-Instruct",
        name: "Qwen 2.5 72B",
        contextLength: 8192,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        pricing: { promptPer1M: 0, completionPer1M: 0 },
      },
    ],
  },
  cliproxyapi: {
    id: "cliproxyapi",
    name: "CLIProxyAPI",
    type: "local",
    apiKeyRequired: true,
    baseURLRequired: true,
    defaultModel: "gemini-2.5-flash",
    category: "aggregator",
    description: "Self-hosted AI proxy aggregating multiple providers",
    website: "https://help.router-for.me",
    dashboardUrl: "http://localhost:8317/management.html",
    docsUrl: "https://help.router-for.me/introduction/quick-start.html",
    models: [
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        contextLength: 1000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: true,
        supportsStreaming: true,
      },
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        contextLength: 2000000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: true,
        supportsStreaming: true,
      },
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        contextLength: 200000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
      {
        id: "gpt-4o",
        name: "GPT-4o",
        contextLength: 128000,
        supportsTools: true,
        supportsVision: true,
        supportsAudio: true,
        supportsVideo: false,
        supportsStreaming: true,
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextLength: 1048576,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
      {
        id: "deepseek-chat",
        name: "DeepSeek Chat (Legacy)",
        contextLength: 1048576,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ],
  },
}

/**
 * Projects a catalog entry's {@link BuiltInProviderCategory} onto the
 * {@link ProviderConfig} category union used by the settings-UI filters and the
 * resolver. The two unions are deliberately kept in sync; spelling the
 * projection out as an exhaustive table turns any future divergence into a
 * compile error here instead of a silent miscategorization.
 */
const CATALOG_CATEGORY_TO_CONFIG: Record<
  NonNullable<BuiltInProviderCatalogEntry["category"]>,
  NonNullable<ProviderConfig["category"]>
> = {
  flagship: "flagship",
  aggregator: "aggregator",
  specialized: "specialized",
  local: "local",
  enterprise: "enterprise",
}

function catalogModelToModelConfig(model: BuiltInProviderModelEntry): ModelConfig {
  return {
    id: model.id,
    name: model.name,
    contextLength: model.contextLength,
    maxOutputTokens: model.maxOutputTokens,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    supportsAudio: model.supportsAudio,
    supportsVideo: model.supportsVideo,
    supportsStreaming: model.supportsStreaming,
    supportsReasoning: model.supportsReasoning,
    supportsImageGeneration: model.supportsImageGeneration,
    supportsEmbedding: model.supportsEmbedding,
    pricing: model.pricing,
  }
}

/**
 * Projects a built-in catalog entry onto the {@link ProviderConfig} shape used
 * by the settings UI and resolver. OAuth fields are intentionally not mapped:
 * OAuth providers keep those richer fields from {@link INLINE_PROVIDERS} when
 * the two sources are merged.
 */
export function catalogEntryToProviderConfig(entry: BuiltInProviderCatalogEntry): ProviderConfig {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    apiKeyRequired: entry.apiKeyRequired,
    baseURLRequired: entry.baseURLRequired,
    defaultBaseURL: entry.defaultBaseURL,
    protocol: entry.protocol,
    defaultEnabled: entry.defaultEnabled,
    placeholderApiKey: entry.placeholderApiKey,
    description: entry.description,
    website: entry.website,
    dashboardUrl: entry.dashboardUrl,
    docsUrl: entry.docsUrl,
    pricingUrl: entry.pricingUrl,
    category: entry.category ? CATALOG_CATEGORY_TO_CONFIG[entry.category] : undefined,
    defaultModel: entry.defaultModel,
    models: (entry.models ?? []).map(catalogModelToModelConfig),
  }
}

/**
 * Marker the catalog uses in an entry's description for embedding / reranker /
 * media providers that expose no chat-completion surface. Such providers are
 * excluded from the settings provider list (they belong to the embedding / TTS
 * subsystems, not the chat-model picker).
 */
const NON_CHAT_CATALOG_MARKER = "Not a chat completion API"

export function isChatCapableCatalogEntry(entry: BuiltInProviderCatalogEntry): boolean {
  return !(entry.description ?? "").includes(NON_CHAT_CATALOG_MARKER)
}

/**
 * Merge current catalog models ahead of inline legacy models. The catalog owns
 * defaults and actively supported model metadata; inline entries retain older
 * selectable IDs for persisted settings and carry richer UI/OAuth metadata.
 */
function mergeProviderModels(current: ModelConfig[], legacy: ModelConfig[]): ModelConfig[] {
  const currentIds = new Set(current.map((model) => model.id))
  return [...current, ...legacy.filter((model) => !currentIds.has(model.id))]
}

/**
 * Builds the full built-in provider map. The catalog is the source of truth
 * for current defaults and model metadata, while inline definitions augment it
 * with richer UI metadata and backwards-compatible legacy model choices.
 */
function buildBuiltInProviders(): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = {}
  for (const entry of getBuiltInProviderCatalog()) {
    if (!isChatCapableCatalogEntry(entry)) continue
    const catalog = catalogEntryToProviderConfig(entry)
    const inline = INLINE_PROVIDERS[entry.id]
    merged[entry.id] = inline
      ? {
          ...catalog,
          ...inline,
          defaultBaseURL: inline.defaultBaseURL ?? catalog.defaultBaseURL,
          protocol: inline.protocol ?? catalog.protocol,
          defaultEnabled: inline.defaultEnabled ?? catalog.defaultEnabled,
          defaultModel: catalog.defaultModel,
          models: mergeProviderModels(catalog.models, inline.models),
        }
      : catalog
  }
  return merged
}

/**
 * Provider definitions consumed across the app (settings UI, model picker,
 * pricing, icons, resolver). Inline curated entries merged with every
 * chat-capable built-in catalog provider — see {@link buildBuiltInProviders}.
 */
export const PROVIDERS: Record<string, ProviderConfig> = buildBuiltInProviders()

export function getProviderConfig(providerId: string): ProviderConfig | undefined {
  return PROVIDERS[providerId]
}

/**
 * Returns the full provider map: inline PROVIDERS merged with any
 * dynamic providers registered at runtime by plugins via
 * `lib/ai/providers/provider-loader`. Dynamic entries spread last so
 * they win on id collision.
 */
export function getAllProviders(): Record<string, ProviderConfig> {
  return { ...PROVIDERS, ...getDynamicProviders() }
}

/**
 * Every known provider id, built-in and dynamic.
 *
 * Cheaper than `Object.keys(getAllProviders())`, which allocates a merged copy
 * of every `ProviderConfig` just to read its keys. Used by Character Pack
 * `requires.providers` validation, which runs on every registry change.
 */
export function listAllProviderIds(): string[] {
  const ids = new Set<string>(Object.keys(PROVIDERS))
  for (const id of Object.keys(getDynamicProviders())) ids.add(id)
  return [...ids]
}

/**
 * True when `providerId` names a provider in the catalog.
 *
 * Catalog membership, not user configuration: a pack requiring `anthropic` is
 * satisfied whether or not the user has added an account, because the pack's
 * dependency is on the provider existing, not on it being signed in.
 */
export function hasProvider(providerId: string): boolean {
  return providerId in PROVIDERS || providerId in getDynamicProviders()
}

// ============================================================================
// Provider Context Types (from provider-context.tsx)
// ============================================================================

// Provider health status
export type ProviderHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown"

// Provider metadata for context
export interface ProviderMetadata {
  id: string
  name: string
  description: string
  website?: string
  requiresApiKey: boolean
  supportsStreaming: boolean
  supportsVision: boolean
  supportsTools: boolean
  maxTokens?: number
  pricingUrl?: string
  icon?: string
}

// Provider health info
export interface ProviderHealth {
  status: ProviderHealthStatus
  lastCheck: Date | null
  latency?: number
  errorRate?: number
  lastError?: string
}

export function getModelConfig(providerId: string, modelId: string): ModelConfig | undefined {
  const provider = PROVIDERS[providerId]
  return provider?.models.find((m) => m.id === modelId)
}
