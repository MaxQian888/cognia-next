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
import { createAzure } from "@ai-sdk/azure"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createCohere } from "@ai-sdk/cohere"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createOpenAI } from "@ai-sdk/openai"
import { createAlibaba } from "@ai-sdk/alibaba"
import { createXai } from "@ai-sdk/xai"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createFireworks } from "@ai-sdk/fireworks"
import { createDeepInfra } from "@ai-sdk/deepinfra"

import {
  LOCAL_PROVIDER_URLS,
  getOpenAICompatibleURL,
  type LocalProviderName,
} from "@cognia/provider-types/local-provider"
import {
  getBuiltInProviderCatalogEntry,
  getBuiltInProviderDefaultBaseURL,
} from "@cognia/provider-types/built-in-provider-catalog"
import type {
  ApiFlavor,
  ApiProtocol,
  BedrockConnectionSettings,
  ResolverProtocol,
} from "@cognia/provider-types"
import { validateBedrockConnectionSettings } from "@cognia/provider-types"
import { createBedrockSidecarLanguageModel } from "@/lib/claude/feature-call"
// Single source of truth for provider→protocol (shared with the sidecar; the
// sidecar can't import `lib/`, so the file lives under `sidecar/` and TS imports
// it — see sidecar/dispatch/protocol-adapters/provider-protocol.mjs).
import {
  resolveProviderProtocol,
  normalizeProtocol,
  decideOpenAiEndpointFlavor,
} from "../../sidecar/dispatch/protocol-adapters/provider-protocol.mjs"

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
  /** Free-form per-provider config consumed by the AI SDK constructors. */
  options?: Record<string, unknown>
}

/**
 * Custom (user-defined) provider, e.g., a self-hosted OpenAI-compatible
 * server. Stored in `AppSettings.customProviders`.
 */
/**
 * Wire protocol the resolver hands downstream. One of the five AI SDK
 * families, or a plugin-contributed protocol-adapter id
 * (`${pluginId}:${id}`) — the sidecar resolves those against the
 * declarative adapter spec; renderer-side feature clients fall back to the
 * openai-compatible client for unknown ids. `(string & {})` keeps literal
 * autocompletion.
 */
// Single definition lives in `@cognia/provider-types` (imported at the top);
// re-exported here so existing importers of this module keep working.
export type { ResolverProtocol }

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
  models?: Array<{ id: string; name?: string; contextLength?: number }>
}

export interface ProviderSettingsSnapshot {
  defaultProvider: string | undefined
  providers: Record<string, ProviderSettingsEntry>
  customProviders: CustomProviderDefinition[]
}

/** Convert a rich custom-provider row to the resolver-facing shape. */
function richToDefinition(rich: RichCustomProviderEntry): CustomProviderDefinition {
  // `apiProtocol` uses the renderer name 'gemini'; the resolver wants 'google'.
  // normalizeProtocol is the single gemini→google bridge (provider-protocol.mjs).
  let protocol: CustomProviderDefinition["protocol"] | undefined = rich.protocol
  if (!protocol && rich.apiProtocol) {
    protocol = normalizeProtocol(rich.apiProtocol) as CustomProviderDefinition["protocol"]
  }
  return {
    id: rich.id,
    name: (rich as { name?: string }).name ?? rich.id,
    enabled: rich.enabled,
    protocol,
    apiFlavor: rich.apiFlavor,
    baseURL: rich.baseURL,
    apiKey: rich.apiKey,
    defaultModel: rich.defaultModel,
  }
}

/**
 * Looser shape for `customProviders` — accepts either the lean
 * `CustomProviderDefinition` or the rich `CustomProviderSettings` shape
 * stored in `AppSettings`. The resolver only reads `id`, `apiKey`,
 * `baseURL`, `defaultModel`, and `protocol`/`apiProtocol`, all of which
 * exist on both shapes.
 */
export interface RichCustomProviderEntry {
  id: string
  /** `false` = disabled in Settings; undefined counts as enabled. */
  enabled?: boolean
  /** Either form of the protocol field — converted in `resolveOne`. */
  protocol?: ResolverProtocol
  apiProtocol?: "openai" | "anthropic" | "gemini" | (string & {})
  /** OpenAI endpoint family override (responses/chat/auto). */
  apiFlavor?: ApiFlavor
  baseURL?: string
  apiKey?: string
  defaultModel?: string
}

export interface ProviderSettingsSnapshotInput {
  defaultProvider: string | undefined
  providerSettings: Record<string, ProviderSettingsEntry> | undefined
  customProviders: RichCustomProviderEntry[] | undefined
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
    "missing_credential" | "provider_disabled" | "no_candidates" | "policy_blocked" | (string & {})
}

export type ProviderResolution = ResolvedProvider | UnresolvedProvider

export interface FeatureClientConfig {
  providerId: string
  apiKey: string | undefined
  baseURL: string | undefined
  bedrock?: BedrockConnectionSettings
  protocol: ResolvedProvider["protocol"]
  apiFlavor?: ApiFlavor
  isCustomProvider: boolean
  useProxy: boolean
  /**
   * Optional custom `fetch` threaded into the AI SDK provider client. The
   * standalone (BYOK) mobile chat path injects a streaming-capable native
   * WebView fetch here so token streaming survives Capacitor (whose patched
   * global `fetch` buffers the whole response — see lib/runtime/streaming-fetch).
   */
  fetch?: typeof globalThis.fetch
  /**
   * Optional extra request headers (e.g. the Anthropic browser-direct opt-in
   * `anthropic-dangerous-direct-browser-access`) merged by the provider client.
   */
  headers?: Record<string, string>
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
    customProviders: (input.customProviders ?? []).map(richToDefinition),
  }
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * First non-empty string among `vals`. The settings UI persists cleared
 * fields as `""` (controlled inputs), and a stale `providerSettings` entry
 * can shadow a custom provider's real values through plain `??` — an empty
 * base URL that shadows the configured one silently re-routes an
 * openai-protocol turn to api.openai.com. Treat blank as unset everywhere.
 */
function pickNonEmpty(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v
  }
  return undefined
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

  // The enabled toggle for a custom provider lives on the custom row itself;
  // a same-id `providerSettings` shadow entry (parameter edits, legacy data)
  // must not override it — and vice versa a disabled custom provider must
  // actually be skipped (the Settings toggle was previously ignored here).
  if (custom ? custom.enabled === false : builtin && builtin.enabled === false) {
    return {
      kind: "unresolved",
      reason: `Provider "${providerId}" is disabled.`,
      nextAction: "enable_provider",
      attemptedProviderIds: [providerId],
    }
  }

  // When a custom definition exists it is the source of truth for its own id
  // (the Settings UI writes custom credentials to `customProviders`); the
  // `providerSettings` entry is only a fallback shadow. Built-ins keep the
  // `providerSettings`-first order. Blank strings never win (see pickNonEmpty).
  const protocol: ResolvedProvider["protocol"] = normalizeProtocol(
    (custom ? (custom.protocol ?? builtin?.apiProtocol) : builtin?.apiProtocol) ??
      resolveProviderProtocol(providerId) ??
      "openai"
  ) as ResolvedProvider["protocol"]

  const apiKey = custom
    ? pickNonEmpty(custom.apiKey, builtin?.apiKey)
    : pickNonEmpty(builtin?.apiKey)
  let baseURL = custom
    ? pickNonEmpty(custom.baseURL, builtin?.baseURL)
    : pickNonEmpty(builtin?.baseURL)
  const model = custom
    ? pickNonEmpty(custom.defaultModel, builtin?.defaultModel)
    : pickNonEmpty(builtin?.defaultModel)
  // Explicit Responses/Chat override (built-in or custom), forwarded to the
  // sidecar so the user can opt a gateway / Azure / custom URL into /responses.
  const apiFlavor = custom ? (custom.apiFlavor ?? builtin?.apiFlavor) : builtin?.apiFlavor
  const bedrock = !custom ? builtin?.bedrock : undefined

  // Local inference engines (Ollama, LM Studio, llama.cpp, vLLM, …) listen on
  // a well-known localhost port and need no API key. When the user enabled a
  // built-in local provider without typing a base URL, fall back to the
  // catalog default — normalised to the OpenAI-compatible `/v1` surface the
  // AI SDK's openai client expects — so the turn can actually dispatch.
  if (!baseURL && !custom && providerId in LOCAL_PROVIDER_URLS) {
    baseURL = getOpenAICompatibleURL(LOCAL_PROVIDER_URLS[providerId as LocalProviderName])
  }

  // Built-in cloud aggregators (OpenRouter, DeepSeek, Groq, xAI, TogetherAI, …)
  // map to the "openai" protocol but live on their OWN host. Their catalog entry
  // has `baseURLRequired: false`, so `buildDefaultBuiltInProviderSettings` never
  // stores a base URL — the user only pastes a key. Without a fallback the
  // openai client silently defaults to api.openai.com, so e.g. an OpenRouter key
  // (sk-or-…) gets sent to OpenAI and rejected. Fall back to the catalog default
  // base URL so the request reaches the provider the user actually selected.
  if (!baseURL && !custom) {
    baseURL = getBuiltInProviderDefaultBaseURL(providerId)
  }

  const validBedrockCredentials =
    protocol === "bedrock" && bedrock ? validateBedrockConnectionSettings(bedrock).valid : false

  if (!apiKey && !baseURL && !validBedrockCredentials) {
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
    apiFlavor,
    apiKey,
    baseURL,
    bedrock,
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
      // Custom providers are configured exclusively in `customProviders` —
      // without this they could never be picked implicitly, so a user whose
      // ONLY configured provider is a custom gateway resolved to nothing.
      candidates.push(...snapshot.customProviders.map((p) => p.id))
      break
  }

  if (args.fallbackMode === "ordered" && args.fallbackProviderOrder) {
    candidates.push(...args.fallbackProviderOrder)
  } else if (args.fallbackMode === "first-eligible") {
    candidates.push(...Object.keys(snapshot.providers))
    candidates.push(...snapshot.customProviders.map((p) => p.id))
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
    const catalogEntry = getBuiltInProviderCatalogEntry(providerId)
    if (args.routeProfile === "general-text" && catalogEntry?.supportsChat === false) {
      lastReason = `Provider "${providerId}" does not support chat completions.`
      lastNextAction = "open_provider_settings"
      continue
    }
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
  const { providerId, protocol, apiKey, baseURL, bedrock, fetch: fetchImpl, headers } = config
  const settings: {
    apiKey?: string
    baseURL?: string
    fetch?: typeof globalThis.fetch
    headers?: Record<string, string>
  } = {}
  if (apiKey) settings.apiKey = apiKey
  if (baseURL) settings.baseURL = baseURL
  // `fetch` + `headers` are standard AI SDK `ProviderSettings` fields accepted
  // by every create*() factory below; they default to undefined (global fetch)
  // so non-standalone callers are unaffected.
  if (fetchImpl) settings.fetch = fetchImpl
  if (headers) settings.headers = headers

  switch (providerId) {
    case "qwen":
      return createAlibaba(settings)
    case "xai":
      return createXai(settings)
    case "togetherai":
      return createTogetherAI(settings)
    case "fireworks":
      return createFireworks(settings)
    case "deepinfra":
      return createDeepInfra(settings)
  }

  switch (protocol) {
    case "anthropic":
      return createAnthropic(settings)
    case "google":
      return createGoogleGenerativeAI(settings)
    case "cohere":
      return createCohere(settings)
    case "mistral":
      return createMistral(settings)
    case "azure":
      return createAzure(settings)
    case "bedrock":
      if (bedrock?.authMode === "default-chain") {
        throw new Error("Bedrock default-chain authentication requires the sidecar feature proxy.")
      }
      return createAmazonBedrock({
        ...(bedrock?.authMode === "api-key" || (!bedrock && apiKey)
          ? { apiKey: bedrock?.apiKey ?? apiKey }
          : {}),
        ...(bedrock?.authMode === "iam"
          ? {
              accessKeyId: bedrock.accessKeyId,
              secretAccessKey: bedrock.secretAccessKey,
              ...(bedrock.sessionToken ? { sessionToken: bedrock.sessionToken } : {}),
            }
          : {}),
        ...(bedrock?.region ? { region: bedrock.region } : {}),
        ...(baseURL ? { baseURL } : bedrock?.baseURL ? { baseURL: bedrock.baseURL } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        ...(headers ? { headers } : {}),
      })
    case "openai":
    default:
      return createOpenAI(settings)
  }
}

/**
 * Build a model handle ready for `streamText` / `generateText`. The
 * resolution must come back from `resolveFeatureProvider` — pass it
 * straight in. `transport` optionally injects a custom `fetch` + extra
 * `headers` (used by the standalone BYOK chat path for streaming + the
 * browser-direct CORS opt-in); omit it for the default global-fetch behavior.
 */
export function createFeatureProviderModel(
  resolved: ResolvedProvider,
  transport?: { fetch?: typeof globalThis.fetch; headers?: Record<string, string> }
) {
  if (resolved.protocol === "bedrock" && resolved.bedrock?.authMode === "default-chain") {
    const bedrock = resolved.bedrock
    return createBedrockSidecarLanguageModel({
      modelId: resolved.model ?? defaultModelForProtocol("bedrock"),
      providerId: resolved.providerId,
      credentials: {
        protocol: "bedrock",
        bedrockAuthMode: "default-chain",
        region: bedrock.region,
        baseURL: resolved.baseURL ?? bedrock.baseURL,
        profile: bedrock.profile,
        roleArn: bedrock.roleArn,
        roleSessionName: bedrock.roleSessionName,
      },
    })
  }
  const client = createFeatureProviderClient({
    providerId: resolved.providerId,
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
    bedrock: resolved.bedrock,
    protocol: resolved.protocol,
    apiFlavor: resolved.apiFlavor,
    isCustomProvider: resolved.isCustomProvider,
    useProxy: resolved.useProxy,
    fetch: transport?.fetch,
    headers: transport?.headers,
  })

  const modelId = resolved.model ?? defaultModelForProtocol(resolved.protocol)
  // Cast through `any` so we can dispatch on either the function-call
  // form (`client(modelId)`) or the namespace form (`client.chat(modelId)`)
  // without TS narrowing the union to `never` after the first branch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = client as any
  if (resolved.protocol === "openai" || resolved.protocol === "azure") {
    const flavor = decideOpenAiEndpointFlavor({
      apiFlavor: resolved.apiFlavor,
      baseURL: resolved.baseURL,
      providerId: resolved.providerId,
    })
    if (flavor === "responses" && typeof handle?.responses === "function") {
      return handle.responses(modelId)
    }
    if (typeof handle?.chat === "function") {
      return handle.chat(modelId)
    }
  }
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
    case "azure":
      return "gpt-5"
    case "openai":
    default:
      return "gpt-4o-mini"
  }
}
