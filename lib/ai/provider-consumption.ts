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
import { createCohere } from "@ai-sdk/cohere"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createOpenAI } from "@ai-sdk/openai"

import {
  LOCAL_PROVIDER_URLS,
  getOpenAICompatibleURL,
  type LocalProviderName,
} from "@cognia/provider-types/local-provider"
import { getBuiltInProviderDefaultBaseURL } from "@cognia/provider-types/built-in-provider-catalog"
import type { ApiFlavor, ResolverProtocol } from "@cognia/provider-types"
// Single source of truth for provider→protocol (shared with the sidecar; the
// sidecar can't import `lib/`, so the file lives under `sidecar/` and TS imports
// it — see sidecar/dispatch/protocol-adapters/provider-protocol.mjs).
import {
  resolveProviderProtocol,
  normalizeProtocol,
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
  /** OpenAI endpoint family override (responses/chat/auto); omitted = auto. */
  apiFlavor?: ApiFlavor
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

  const protocol: ResolvedProvider["protocol"] = normalizeProtocol(
    custom?.protocol ?? resolveProviderProtocol(providerId) ?? "openai"
  ) as ResolvedProvider["protocol"]

  const apiKey = builtin?.apiKey ?? custom?.apiKey
  let baseURL = builtin?.baseURL ?? custom?.baseURL
  const model = builtin?.defaultModel ?? custom?.defaultModel
  // Explicit Responses/Chat override (built-in or custom), forwarded to the
  // sidecar so the user can opt a gateway / Azure / custom URL into /responses.
  const apiFlavor = builtin?.apiFlavor ?? custom?.apiFlavor

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
    apiFlavor,
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
  const { protocol, apiKey, baseURL, fetch: fetchImpl, headers } = config
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
      // Bedrock's AI SDK provider pulls AWS SigV4 deps that must not enter the
      // renderer/mobile bundle, so the in-renderer feature path doesn't carry
      // it. The chat path (sidecar/dispatch/ai-sdk-adapter.mjs) supports Bedrock
      // natively — route Bedrock features through a chat turn instead.
      throw new Error(
        "bedrock is only supported via the chat/sidecar path, not the in-renderer feature client"
      )
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
  const client = createFeatureProviderClient({
    providerId: resolved.providerId,
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
    protocol: resolved.protocol,
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
