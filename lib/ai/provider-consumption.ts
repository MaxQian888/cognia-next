/**
 * Provider-consumption helpers used by the plugin AI surface.
 *
 * The plugin runtime wants to ask "which built-in provider should I use
 * right now?" without leaking the configured user keys. This module
 * mediates: it takes the settings store snapshot, resolves the right
 * provider+model+credentials, and returns a thin client / model handle
 * for the AI SDK. Plugin code never touches `AppSettings.providerSettings`
 * directly.
 *
 * The resolver is deliberately framework-agnostic — it doesn't import
 * any zustand store. Callers pass a `ProviderSettingsSnapshot` they
 * built from `createProviderSettingsSnapshot(...)`. That keeps the
 * resolution logic pure and unit-testable.
 */

import { createAnthropic } from "@ai-sdk/anthropic"
import { createCohere } from "@ai-sdk/cohere"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createOpenAI } from "@ai-sdk/openai"

// =============================================================================
// Types
// =============================================================================

/**
 * Per-provider configuration record. Stored on `AppSettings.providerSettings`
 * keyed by provider id. `apiKey` is required for cloud providers; `baseURL`
 * is optional and only used by self-hosted / proxy deployments.
 */
export interface ProviderSettingsEntry {
  enabled?: boolean
  apiKey?: string
  baseURL?: string
  defaultModel?: string
  /** Free-form per-provider config consumed by the AI SDK constructors. */
  options?: Record<string, unknown>
}

/**
 * Custom (user-defined) provider, e.g., a self-hosted OpenAI-compatible
 * server. Stored in `AppSettings.customProviders`.
 */
export interface CustomProviderDefinition {
  id: string
  name: string
  protocol?: "openai" | "anthropic" | "google" | "mistral" | "cohere"
  baseURL?: string
  apiKey?: string
  defaultModel?: string
  models?: Array<{ id: string; name?: string; contextLength?: number }>
}

export interface ProviderSettingsSnapshot {
  defaultProvider: string | undefined
  providers: Record<string, ProviderSettingsEntry>
  customProviders: CustomProviderDefinition[]
}

export interface ProviderSettingsSnapshotInput {
  defaultProvider: string | undefined
  providerSettings: Record<string, ProviderSettingsEntry> | undefined
  customProviders: CustomProviderDefinition[] | undefined
}

export type FeatureRouteProfile = "general-text" | "embedding" | "vision" | "capability-bound"

export type FeatureSelectionMode = "explicit-provider" | "supported-providers" | "any"

export type FeatureFallbackMode = "none" | "ordered" | "first-eligible"

export interface ResolveFeatureProviderArgs {
  featureId: string
  routeProfile: FeatureRouteProfile
  selectionMode: FeatureSelectionMode
  /** When `selectionMode === 'explicit-provider'`. */
  providerId?: string
  /** When `selectionMode === 'supported-providers'`. */
  supportedProviders?: string[]
  fallbackMode: FeatureFallbackMode
  fallbackProviderOrder?: string[]
  executionMode?: "direct-model" | "client"
  proxyMode?: "preferred" | "always" | "never"
}

export type ResolutionFailureNextAction =
  | "add_api_key"
  | "enable_provider"
  | "configure_base_url"
  | "select_default_model"
  | "verify_connection"
  | "open_provider_settings"

export interface ResolvedProvider {
  kind: "resolved"
  providerId: string
  protocol: "openai" | "anthropic" | "google" | "mistral" | "cohere"
  apiKey: string | undefined
  baseURL: string | undefined
  model: string | undefined
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

export interface UnresolvedProvider {
  kind: "unresolved" | "blocked"
  reason: string
  nextAction?: ResolutionFailureNextAction
  attemptedProviderIds: string[]
  /** Feature id mirroring the resolution arguments — useful for telemetry. */
  featureId?: string
  /** Route profile mirroring the resolution arguments. */
  routeProfile?: FeatureRouteProfile
  /** Provider id that the resolver tried last (when applicable). */
  providerId?: string
  /** Provider ids that would have been used as fallbacks. */
  fallbackProviderIds?: string[]
  /** Provider ids the request supports (helps the picker explain why). */
  supportedProviderIds?: string[]
  /** Machine-readable failure code, e.g., `"missing_credential"`. */
  code?:
    | "missing_credential"
    | "provider_disabled"
    | "no_candidates"
    | "policy_blocked"
    | (string & {})
}

export type ProviderResolution = ResolvedProvider | UnresolvedProvider

export interface FeatureClientConfig {
  providerId: string
  apiKey: string | undefined
  baseURL: string | undefined
  protocol: ResolvedProvider["protocol"]
  isCustomProvider: boolean
  useProxy: boolean
}

// =============================================================================
// Snapshot construction
// =============================================================================

export function createProviderSettingsSnapshot(
  input: ProviderSettingsSnapshotInput
): ProviderSettingsSnapshot {
  return {
    defaultProvider: input.defaultProvider,
    providers: { ...(input.providerSettings ?? {}) },
    customProviders: [...(input.customProviders ?? [])],
  }
}

// =============================================================================
// Resolution
// =============================================================================

const BUILTIN_PROTOCOLS: Record<string, ResolvedProvider["protocol"]> = {
  openai: "openai",
  xai: "openai",
  togetherai: "openai",
  fireworks: "openai",
  deepinfra: "openai",
  groq: "openai",
  anthropic: "anthropic",
  google: "google",
  cohere: "cohere",
  mistral: "mistral",
}

function resolveOne(
  providerId: string,
  snapshot: ProviderSettingsSnapshot
): ResolvedProvider | UnresolvedProvider {
  const custom = snapshot.customProviders.find((p) => p.id === providerId)
  const builtin = snapshot.providers[providerId]

  if (!custom && !builtin) {
    return {
      kind: "unresolved",
      reason: `Provider "${providerId}" is not configured.`,
      nextAction: "open_provider_settings",
      attemptedProviderIds: [providerId],
    }
  }

  if (builtin && builtin.enabled === false) {
    return {
      kind: "unresolved",
      reason: `Provider "${providerId}" is disabled.`,
      nextAction: "enable_provider",
      attemptedProviderIds: [providerId],
    }
  }

  const protocol: ResolvedProvider["protocol"] =
    (custom?.protocol as ResolvedProvider["protocol"]) ?? BUILTIN_PROTOCOLS[providerId] ?? "openai"

  const apiKey = builtin?.apiKey ?? custom?.apiKey
  const baseURL = builtin?.baseURL ?? custom?.baseURL
  const model = builtin?.defaultModel ?? custom?.defaultModel

  if (!apiKey && !baseURL) {
    return {
      kind: "unresolved",
      reason: `Provider "${providerId}" is missing both an API key and a base URL.`,
      nextAction: "add_api_key",
      attemptedProviderIds: [providerId],
    }
  }

  return {
    kind: "resolved",
    providerId,
    protocol,
    apiKey,
    baseURL,
    model,
    isCustomProvider: Boolean(custom),
    useProxy: false,
  }
}

export function resolveFeatureProvider(
  args: ResolveFeatureProviderArgs,
  snapshot: ProviderSettingsSnapshot
): ProviderResolution {
  const attempted: string[] = []
  const candidates: string[] = []

  switch (args.selectionMode) {
    case "explicit-provider":
      if (args.providerId) candidates.push(args.providerId)
      break
    case "supported-providers":
      candidates.push(...(args.supportedProviders ?? []))
      break
    case "any":
      if (snapshot.defaultProvider) candidates.push(snapshot.defaultProvider)
      candidates.push(...Object.keys(snapshot.providers))
      break
  }

  if (args.fallbackMode === "ordered" && args.fallbackProviderOrder) {
    candidates.push(...args.fallbackProviderOrder)
  } else if (args.fallbackMode === "first-eligible") {
    candidates.push(...Object.keys(snapshot.providers))
  }

  // De-dupe while preserving order.
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const id of candidates) {
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }

  let lastReason = "No candidate providers were available."
  let lastNextAction: ResolutionFailureNextAction | undefined = "open_provider_settings"

  for (const providerId of ordered) {
    attempted.push(providerId)
    const resolution = resolveOne(providerId, snapshot)
    if (resolution.kind === "resolved") return resolution
    lastReason = resolution.reason
    lastNextAction = resolution.nextAction
  }

  return {
    kind: "unresolved",
    reason: lastReason,
    nextAction: lastNextAction,
    attemptedProviderIds: attempted,
  }
}

// =============================================================================
// AI SDK client / model construction
// =============================================================================

export function createFeatureProviderClient(config: FeatureClientConfig) {
  const { protocol, apiKey, baseURL } = config
  const settings: { apiKey?: string; baseURL?: string } = {}
  if (apiKey) settings.apiKey = apiKey
  if (baseURL) settings.baseURL = baseURL

  switch (protocol) {
    case "anthropic":
      return createAnthropic(settings)
    case "google":
      return createGoogleGenerativeAI(settings)
    case "cohere":
      return createCohere(settings)
    case "mistral":
      return createMistral(settings)
    case "openai":
    default:
      return createOpenAI(settings)
  }
}

/**
 * Build a model handle ready for `streamText` / `generateText`. The
 * resolution must come back from `resolveFeatureProvider` — pass it
 * straight in.
 */
export function createFeatureProviderModel(resolved: ResolvedProvider) {
  const client = createFeatureProviderClient({
    providerId: resolved.providerId,
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
    protocol: resolved.protocol,
    isCustomProvider: resolved.isCustomProvider,
    useProxy: resolved.useProxy,
  })

  const modelId = resolved.model ?? defaultModelForProtocol(resolved.protocol)
  // Cast through `any` so we can dispatch on either the function-call
  // form (`client(modelId)`) or the namespace form (`client.chat(modelId)`)
  // without TS narrowing the union to `never` after the first branch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = client as any
  if (typeof handle === "function") return handle(modelId)
  if (typeof handle?.chat === "function") return handle.chat(modelId)
  throw new Error(
    `createFeatureProviderModel: client for ${resolved.providerId} has no model entrypoint`
  )
}

function defaultModelForProtocol(protocol: ResolvedProvider["protocol"]): string {
  switch (protocol) {
    case "anthropic":
      return "claude-sonnet-4-6"
    case "google":
      return "gemini-1.5-flash"
    case "cohere":
      return "command-r"
    case "mistral":
      return "mistral-small-latest"
    case "openai":
    default:
      return "gpt-4o-mini"
  }
}
