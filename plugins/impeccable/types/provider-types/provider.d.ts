import { BuiltInProviderId, BuiltInProviderCatalogEntry } from "./built-in-provider-catalog.js"
import { BedrockConnectionSettings } from "./bedrock.js"

/**
 * AI Provider type definitions
 */

type ProviderType = "cloud" | "local"
type ProviderName = BuiltInProviderId | "auto"
/** Pricing tiers for a model, all denominated per 1 million tokens (USD). */
interface ModelPricing {
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
interface ModelConfig {
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
interface ProviderModelDiscoveryEntry {
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
type Model = ModelConfig
interface ProviderConfig {
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
  supportsOAuth?: boolean
  oauthConfig?: OAuthConfig
  description?: string
  website?: string
  dashboardUrl?: string
  docsUrl?: string
  pricingUrl?: string
  category?: "flagship" | "aggregator" | "specialized" | "local" | "enterprise"
}
interface OAuthConfig {
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
type OAuthRuleTransform = "to-string" | "to-number" | "to-boolean"
interface OAuthValueFromRule {
  from: string
  transforms?: OAuthRuleTransform[]
}
interface OAuthValueLiteralRule {
  literal: string | number | boolean | null
  transforms?: OAuthRuleTransform[]
}
type OAuthRuleValue = OAuthValueFromRule | OAuthValueLiteralRule
interface OAuthCallbackConfig {
  extract?: Record<string, string>
}
interface OAuthExchangeConfig {
  method?: "GET" | "POST"
  headers?: Record<string, OAuthRuleValue>
  body?: Record<string, OAuthRuleValue>
  response?: Record<string, string>
}
type ApiKeyRotationStrategy = "round-robin" | "random" | "least-used"
interface ApiKeyUsageStats {
  usageCount: number
  lastUsed: number
  errorCount: number
  lastError?: string
}
type ProviderVerificationStatus = "unverified" | "verified" | "stale"
/** Provider-level inference parameter defaults (overrides global, overridden by session) */
interface ProviderInferenceDefaults {
  temperature?: number
  maxTokens?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
}
/** Connection parameters for a provider */
interface ProviderConnectionParams {
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
interface ModelInferenceParams {
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
interface UserProviderSettings {
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
  enabledModels?: string[]
  apiKeys?: string[]
  apiKeyRotationEnabled?: boolean
  apiKeyRotationStrategy?: ApiKeyRotationStrategy
  apiKeyUsageStats?: Record<string, ApiKeyUsageStats>
  currentKeyIndex?: number
  oauthConnected?: boolean
  oauthExpiresAt?: number
  verificationStatus?: ProviderVerificationStatus
  lastVerifiedAt?: number
  verificationFingerprint?: string
  verificationMessage?: string
  lastHealthCheck?: number
  healthStatus?: "healthy" | "degraded" | "error" | "unknown"
  quotaUsed?: number
  quotaLimit?: number
  rateLimitRemaining?: number
  openRouterSettings?: OpenRouterProviderSettings
  cliProxyAPISettings?: CLIProxyAPIProviderSettings
  /** Provider-level inference parameter defaults */
  inferenceDefaults?: ProviderInferenceDefaults
  /** Provider-specific parameters (e.g., reasoning_effort, thinking budget) */
  providerSpecificParams?: Record<string, unknown>
  /** Connection parameters */
  connectionParams?: ProviderConnectionParams
  /** Advanced parameters (response format, seed, etc.) */
  advancedParams?: Record<string, unknown>
}
interface CLIProxyAPIProviderSettings {
  host?: string
  port?: number
  managementKey?: string
  allowRemoteManagement?: boolean
  routingStrategy?: "round-robin" | "fill-first"
  requestRetry?: number
  maxRetryInterval?: number
  quotaExceededSwitchProject?: boolean
  quotaExceededSwitchPreviewModel?: boolean
  streamingKeepaliveSeconds?: number
  streamingBootstrapRetries?: number
  webUIEnabled?: boolean
  webUILastOpened?: number
  usageStatisticsEnabled?: boolean
  lastHealthCheck?: number
  connectionStatus?: "connected" | "disconnected" | "error"
  serverVersion?: string
  availableModels?: string[]
  modelsLastFetched?: number
}
interface OpenRouterProviderSettings {
  provisioningApiKey?: string
  byokKeys?: BYOKKeyEntry[]
  providerOrdering?: {
    enabled: boolean
    allowFallbacks: boolean
    order: string[]
  }
  credits?: number
  creditsUsed?: number
  creditsRemaining?: number
  creditsLastFetched?: number
  modelsLastFetched?: number
  siteUrl?: string
  siteName?: string
}
interface BYOKKeyEntry {
  id: string
  provider: BYOKProvider
  config: string
  alwaysUse: boolean
  enabled: boolean
  name?: string
}
type BYOKProvider =
  "openai" | "anthropic" | "google" | "azure" | "bedrock" | "vertex" | "mistral" | "cohere" | "groq"
/**
 * The three protocols custom providers can speak out of the box.
 * - openai: OpenAI-compatible API (most common, used by many providers)
 * - anthropic: Anthropic Claude API format
 * - gemini: Google Gemini API format
 */
type BuiltInApiProtocol = "openai" | "anthropic" | "gemini" | "bedrock"
/** The built-in protocols, for pickers and exhaustive iteration. */
declare const BUILTIN_API_PROTOCOLS: readonly BuiltInApiProtocol[]
/**
 * API Protocol for custom providers — one of the built-ins or a
 * plugin-contributed protocol-adapter id (`${pluginId}:${id}`, resolved via
 * `lib/ai/providers/protocol-adapter-registry`). `(string & {})` keeps
 * literal autocompletion while accepting registered custom ids.
 */
type ApiProtocol = BuiltInApiProtocol | (string & {})
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
type ResolverProtocol =
  "openai" | "anthropic" | "google" | "mistral" | "cohere" | "azure" | "bedrock" | (string & {})
/**
 * OpenAI endpoint family selection. "responses"/"chat" override the host
 * heuristic — this is what unlocks the Responses API on Azure OpenAI, on
 * compatible gateways that proxy `/responses`, and on custom base URLs. "auto"
 * (or undefined) falls back to the heuristic in
 * `decideOpenAiEndpointFlavor` (provider-protocol.mjs).
 */
type ApiFlavor = "auto" | "responses" | "chat"
/**
 * Per-model capability/pricing overrides for a custom provider. Mirrors
 * Cognia's `CustomModelMetadata`. Persisted on the parent
 * `CustomProviderSettings.customModelMetadata` map keyed by model id.
 */
interface CustomModelMetadata {
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
interface CustomProviderSettings extends UserProviderSettings {
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
interface ProviderModelUsageEntry {
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
interface ProviderUIPreferences {
  /** Last provider opened in the settings detail pane. */
  selectedProviderId?: string
  /** Filter by status badge in the sidebar. */
  statusFilter?: "all" | "connected" | "error" | "not-configured"
  /** Filter by category from the catalog (flagship / aggregator / local / …). */
  categoryFilter?: string
  /** Sort order for the sidebar list. */
  sortBy?: "name" | "status" | "lastUsed"
  /** Comparison view selection (multi-select). */
  comparisonProviderIds?: string[]
  /** Sidebar width in px (resizable handle). */
  sidebarWidth?: number
}
/**
 * Projects a built-in catalog entry onto the {@link ProviderConfig} shape used
 * by the settings UI and resolver. OAuth fields are intentionally not mapped:
 * OAuth providers keep those richer fields from {@link INLINE_PROVIDERS} when
 * the two sources are merged.
 */
declare function catalogEntryToProviderConfig(entry: BuiltInProviderCatalogEntry): ProviderConfig
declare function isChatCapableCatalogEntry(entry: BuiltInProviderCatalogEntry): boolean
/**
 * Provider definitions consumed across the app (settings UI, model picker,
 * pricing, icons, resolver). Inline curated entries merged with every
 * chat-capable built-in catalog provider — see {@link buildBuiltInProviders}.
 */
declare const PROVIDERS: Record<string, ProviderConfig>
declare function getProviderConfig(providerId: string): ProviderConfig | undefined
/**
 * Returns the full provider map: inline PROVIDERS merged with any
 * dynamic providers registered at runtime by plugins via
 * `lib/ai/providers/provider-loader`. Dynamic entries spread last so
 * they win on id collision.
 */
declare function getAllProviders(): Record<string, ProviderConfig>
/**
 * Every known provider id, built-in and dynamic.
 *
 * Cheaper than `Object.keys(getAllProviders())`, which allocates a merged copy
 * of every `ProviderConfig` just to read its keys. Used by Character Pack
 * `requires.providers` validation, which runs on every registry change.
 */
declare function listAllProviderIds(): string[]
/**
 * True when `providerId` names a provider in the catalog.
 *
 * Catalog membership, not user configuration: a pack requiring `anthropic` is
 * satisfied whether or not the user has added an account, because the pack's
 * dependency is on the provider existing, not on it being signed in.
 */
declare function hasProvider(providerId: string): boolean
type ProviderHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown"
interface ProviderMetadata {
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
interface ProviderHealth {
  status: ProviderHealthStatus
  lastCheck: Date | null
  latency?: number
  errorRate?: number
  lastError?: string
}
declare function getModelConfig(providerId: string, modelId: string): ModelConfig | undefined

export {
  type ApiFlavor,
  type ApiKeyRotationStrategy,
  type ApiKeyUsageStats,
  type ApiProtocol,
  BUILTIN_API_PROTOCOLS,
  type BYOKKeyEntry,
  type BYOKProvider,
  type BuiltInApiProtocol,
  type CLIProxyAPIProviderSettings,
  type CustomModelMetadata,
  type CustomProviderSettings,
  type Model,
  type ModelConfig,
  type ModelInferenceParams,
  type ModelPricing,
  type OAuthCallbackConfig,
  type OAuthConfig,
  type OAuthExchangeConfig,
  type OAuthRuleTransform,
  type OAuthRuleValue,
  type OAuthValueFromRule,
  type OAuthValueLiteralRule,
  type OpenRouterProviderSettings,
  PROVIDERS,
  type ProviderConfig,
  type ProviderConnectionParams,
  type ProviderHealth,
  type ProviderHealthStatus,
  type ProviderInferenceDefaults,
  type ProviderMetadata,
  type ProviderModelDiscoveryEntry,
  type ProviderModelUsageEntry,
  type ProviderName,
  type ProviderType,
  type ProviderUIPreferences,
  type ProviderVerificationStatus,
  type ResolverProtocol,
  type UserProviderSettings,
  catalogEntryToProviderConfig,
  getAllProviders,
  getModelConfig,
  getProviderConfig,
  hasProvider,
  isChatCapableCatalogEntry,
  listAllProviderIds,
}
