/**
 * The plugin contract's share of `lib/ai/provider-consumption.ts`, which re-exports these.
 */
import type {
  ApiFlavor,
  ApiProtocol,
  BedrockConnectionSettings,
  CustomProviderSettings,
  ProviderModelDiscoveryEntry,
  ResolverProtocol,
} from "@cognia/provider-types"

/**
 * Per-provider configuration record. Stored on `AppSettings.providerSettings`
 * keyed by provider id. `apiKey` is required for cloud providers; `baseURL`
 * is optional and only used by self-hosted / proxy deployments.
 */
export interface ProviderSettingsEntry {
  enabled?: boolean
  apiKey?: string
  baseURL?: string
  bedrock?: BedrockConnectionSettings
  /** OpenAI endpoint family override (responses/chat/auto); omitted = auto. */
  apiFlavor?: ApiFlavor
  /**
   * Wire protocol override for built-in providers other than `"anthropic"`
   * (which always dispatches through the native Claude Agent SDK subprocess
   * regardless of this field). Undefined = use the catalog's fixed protocol
   * for this provider id.
   */
  apiProtocol?: ApiProtocol
  defaultModel?: string
  /**
   * Static transport headers (`UserProviderSettings.customHeaders`, ADR-0090
   * Phase 1). Stamped on every request to the provider — gateway auth
   * headers, tenant ids, etc.
   */
  customHeaders?: Record<string, string>
  /** Free-form per-provider config consumed by the AI SDK constructors. */
  options?: Record<string, unknown>
}

export interface CustomProviderDefinition {
  id: string
  name: string
  /** `false` = the user disabled this provider; undefined counts as enabled. */
  enabled?: boolean
  protocol?: ResolverProtocol
  /** OpenAI endpoint family override (responses/chat/auto); omitted = auto. */
  apiFlavor?: ApiFlavor
  baseURL?: string
  apiKey?: string
  defaultModel?: string
  /** Static transport headers (`CustomProviderSettings.customHeaders`). */
  customHeaders?: Record<string, string>
  models?: ProviderModelDiscoveryEntry[]
  subscription?: CustomProviderSettings["subscription"]
}

export interface ProviderSettingsSnapshot {
  defaultProvider: string | undefined
  providers: Record<string, ProviderSettingsEntry>
  customProviders: CustomProviderDefinition[]
}

export type FeatureRouteProfile = "general-text" | "embedding" | "vision" | "capability-bound"

export interface ResolvedProvider {
  kind: "resolved"
  providerId: string
  protocol: ResolverProtocol
  /**
   * OpenAI endpoint family override (responses/chat/auto). Forwarded to the
   * sidecar via `providerCredentials.apiFlavor`; consumed by
   * `decideOpenAiEndpointFlavor`. Omitted = "auto".
   */
  apiFlavor?: ApiFlavor
  apiKey: string | undefined
  baseURL: string | undefined
  bedrock?: BedrockConnectionSettings
  model: string | undefined
  /**
   * Static request headers from the provider's `customHeaders`. Consumers
   * merge them under any transport-level headers (browser-direct opt-in,
   * vault-issued relay headers), which take precedence.
   */
  headers?: Record<string, string>
  isCustomProvider: boolean
  useProxy: boolean
  /** Free-form feature id forwarded from the resolution arguments. */
  featureId?: string
  /** Route profile mirroring the resolution arguments. */
  routeProfile?: FeatureRouteProfile
  /** Execution mode mirroring the resolution arguments. */
  executionMode?: "direct-model" | "client"
  /** Provider ids the resolver attempted before settling. */
  attemptedProviderIds?: string[]
  /** Provider ids that would have been used as fallbacks. */
  fallbackProviderIds?: string[]
}
