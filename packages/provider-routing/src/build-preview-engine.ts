/**
 * Routing-engine factory shared by the chat send path and the settings
 * routing-tab's test/preview panel.
 *
 * Assembles a `ProviderRoutingEngine` whose deps read the LIVE in-memory
 * stores (health metrics, circuit breaker, today-spend mirror, rate window)
 * plus the given `AppSettings` — exactly what `resolveSendOptions` uses, so a
 * preview answers "which provider WOULD the next send pick right now".
 * Catalog construction is memoized by the immutable settings snapshot. The
 * normal routing path performs no database or network work; only contributed
 * plugin selectors/filters may be awaited.
 */

import { createMappingRegistry } from "./model-mapping-registry"
import { ProviderRoutingEngine, type RoutingEngineDeps } from "./provider-routing-engine"
import { getSessionDeployment, releaseSessionDeployment } from "./session-affinity-store"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"
import {
  getAllProviders,
  type CustomProviderSettings,
  type ProviderModelDiscoveryEntry,
} from "@cognia/provider-types/provider"
import { isLocalProviderName } from "@cognia/provider-types/local-provider"
import {
  resolveModelPriceUsdPer1M,
  type PriceLookupSettings,
} from "@cognia/provider-core/providers/model-pricing"
import { getCatalogModelMetadata } from "@cognia/provider-core/providers/models-dev-sync"
import {
  getProviderDefinition,
  listProviderDefinitions,
} from "@cognia/provider-core/providers/provider-loader"
import {
  getModelContextLimits,
  getModelMaxTokens,
  getProviderRoutingRuntimeAdapters,
} from "./runtime-adapters"
// Side-effect import: registers the "difficulty" strategy so every engine
// (send path + preview panel) can resolve it by id.
import "./difficulty-router"
import type { ModelMapping, RoutingConfig } from "@cognia/provider-types/model-mapping"
import { collectOptions } from "./model-option-source"
import type { RoutingCandidateCapabilities } from "@cognia/provider-types/auto-router"

/** The slice of AppSettings the engine deps actually read. */
export interface RoutingEngineSettings extends PriceLookupSettings {
  modelMappings?: ModelMapping[]
  routingConfig?: RoutingConfig
  providerSettings?: PriceLookupSettings["providerSettings"] &
    Record<
      string,
      { enabled?: boolean; discoveredModels?: ProviderModelDiscoveryEntry[] } | undefined
    >
  customProviders?: Array<{
    id: string
    providerId?: string
    enabled?: boolean
    defaultModel?: string
    customModelMetadata?: Record<string, RoutingModelMetadata | undefined>
    subscription?: CustomProviderSettings["subscription"]
  }>
}

export interface RoutingCatalogSnapshot {
  candidates: readonly { providerId: string; modelId: string }[]
  capabilities: ReadonlyMap<string, RoutingCandidateCapabilities | undefined>
}

const catalogSnapshots = new WeakMap<
  object,
  {
    snapshot: RoutingCatalogSnapshot
    definitions: ReturnType<typeof listProviderDefinitions>
  }
>()

function catalogKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`
}

type RoutingModelMetadata = Partial<ProviderModelDiscoveryEntry> & {
  capabilities?: { vision?: boolean; functionCalling?: boolean; streaming?: boolean }
}

function resolveCandidateMetadata(
  appSettings: RoutingEngineSettings,
  id: string,
  modelId: string,
  providerCatalog = getAllProviders()
): RoutingModelMetadata | undefined {
  const discovered = appSettings.providerSettings?.[id]?.discoveredModels?.find(
    (model) => model.id === modelId
  )
  const customProvider = appSettings.customProviders?.find((provider) => provider.id === id)
  const custom = customProvider?.customModelMetadata?.[modelId]
  const catalog = getCatalogModelMetadata(id, modelId)
  const providerModel = providerCatalog[id]?.models.find((model) => model.id === modelId)
  // Subscription discovery describes this account's real limits. Ordinary
  // custom provider metadata remains an explicit user override.
  const sources = (
    customProvider?.subscription
      ? [discovered, custom, catalog, providerModel]
      : [custom, discovered, catalog, providerModel]
  ).filter((source): source is RoutingModelMetadata => source !== undefined)
  if (!sources.length) return undefined
  const output: RoutingModelMetadata = {}
  const fields = [
    "supportsTools",
    "supportsVision",
    "supportsAudio",
    "supportsVideo",
    "supportsReasoning",
    "supportsStructuredOutput",
    "supportsStreaming",
    "contextLength",
    "maxInputTokens",
    "maxOutputTokens",
  ] as const
  for (const field of fields) {
    for (const source of sources) {
      if (source.knownFields && !source.knownFields.includes(field)) continue
      const alias =
        field === "supportsTools"
          ? source.capabilities?.functionCalling
          : field === "supportsVision"
            ? source.capabilities?.vision
            : field === "supportsStreaming"
              ? source.capabilities?.streaming
              : undefined
      const value = source[field] ?? alias
      if (typeof value === "boolean" && field.startsWith("supports")) {
        output[field] = value as never
        break
      }
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value > 0 &&
        !field.startsWith("supports")
      ) {
        output[field] = value as never
        break
      }
    }
  }
  return output
}

function resolveCandidateCapabilities(
  appSettings: RoutingEngineSettings,
  id: string,
  modelId: string,
  providerCatalog = getAllProviders()
): RoutingCandidateCapabilities | undefined {
  const source = resolveCandidateMetadata(appSettings, id, modelId, providerCatalog)
  const dynamicProtocol = getProviderDefinition(id)?.protocol
  const transportStreaming =
    appSettings.customProviders?.some((provider) => provider.id === id) ||
    dynamicProtocol === "openai" ||
    dynamicProtocol === "anthropic"
      ? true
      : undefined
  if (!source) {
    // Custom OpenAI-compatible gateways are dispatched through streamText even
    // when the user has not supplied optional per-model metadata. Preserve
    // fail-closed behavior for undeclared rich capabilities, but do not reject
    // an explicitly configured custom provider from the mandatory streaming
    // path solely because its model has no catalog row.
    return transportStreaming ? { streaming: true } : undefined
  }
  return {
    tools: source.supportsTools,
    vision: source.supportsVision,
    audio: source.supportsAudio,
    video: source.supportsVideo,
    reasoning: source.supportsReasoning,
    structuredOutput: source.supportsStructuredOutput,
    // This is the protocol's existing streamText fallback, not a newly known
    // model capability. Explicit non-streaming metadata still takes priority.
    streaming: source.supportsStreaming ?? transportStreaming,
    contextTokens: source.contextLength,
  }
}

/** Memoized projection of the existing provider/model option pipeline. */
export function getRoutingCatalogSnapshot(
  appSettings: RoutingEngineSettings
): RoutingCatalogSnapshot {
  const existing = catalogSnapshots.get(appSettings)
  const definitions = listProviderDefinitions()
  if (
    existing &&
    definitions.length === existing.definitions.length &&
    definitions.every((definition, index) => definition === existing.definitions[index])
  )
    return existing.snapshot

  const seen = new Set<string>()
  const candidates = collectOptions(
    appSettings.providerSettings as Parameters<typeof collectOptions>[0],
    appSettings.customProviders as Parameters<typeof collectOptions>[1]
  )
    .map(({ providerId, modelId }) => ({ providerId, modelId }))
    .filter(({ providerId, modelId }) => {
      const key = catalogKey(providerId, modelId)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const capabilities = new Map<string, RoutingCandidateCapabilities | undefined>()
  const providerCatalog = getAllProviders()
  for (const candidate of candidates) {
    capabilities.set(
      catalogKey(candidate.providerId, candidate.modelId),
      resolveCandidateCapabilities(
        appSettings,
        candidate.providerId,
        candidate.modelId,
        providerCatalog
      )
    )
  }
  const snapshot = { candidates, capabilities }
  catalogSnapshots.set(appSettings, { snapshot, definitions })
  return snapshot
}

/** Build the live-store-backed deps `resolveSendOptions` wires into the engine. */
export function buildRoutingEngineDeps(appSettings: RoutingEngineSettings): RoutingEngineDeps {
  const runtime = getProviderRoutingRuntimeAdapters()
  const catalogSnapshot = getRoutingCatalogSnapshot(appSettings)
  return {
    // Real reliability telemetry (ADR-0043 Phase 4), fed per-turn by
    // `recordProviderOutcome`. A provider with zero recorded requests reports
    // `undefined` so the engine treats it as "no-info" and keeps priority
    // order until rolling stats accrue.
    getHealthMetrics: (id) => runtime.getHealthMetrics(id),
    getCircuitBreakerState: (id) => runtime.getCircuitBreakerState(id),
    isProviderAvailable: (id) => {
      // An OPEN circuit breaker takes a provider out of rotation; otherwise
      // fall back to the provider's enabled flag.
      if (!runtime.isCircuitBreakerAvailable(id)) return false
      const enabled = appSettings.providerSettings?.[id]?.enabled
      // Custom providers carry their own `enabled` flag.
      const custom = appSettings.customProviders?.find((p) => p.id === id)
      return enabled !== false || (custom?.enabled !== false && Boolean(custom))
    },
    getPricing: (id, modelId) =>
      resolveModelPriceUsdPer1M(id, modelId, {
        providerSettings: appSettings.providerSettings,
        customProviders: appSettings.customProviders,
      } as PriceLookupSettings),
    // Durable today-spend mirror (hydrated from Dexie at boot, incremented
    // per turn) — makes `dailyCostBudget` survive reloads.
    getTodaySpend: (id) => runtime.getTodaySpend(id),
    // Usable input window = catalog context length (heuristic fallback)
    // minus an output/reserve allowance — feeds the engine's LiteLLM-style
    // context-window pre-check.
    getContextWindow: (id, modelId) => {
      const config = resolveCandidateMetadata(appSettings, id, modelId)
      const raw = config?.contextLength ?? getModelMaxTokens(modelId)
      const limits = getModelContextLimits(modelId)
      const maxOutput = config?.maxOutputTokens
      const reserve = Math.min(
        limits.reserveTokens,
        typeof maxOutput === "number" && maxOutput > 0 ? maxOutput : Infinity
      )
      return Math.min(Math.max(0, raw - reserve), config?.maxInputTokens ?? Infinity)
    },
    // Trailing-minute RPM/TPM window (fed by recordProviderOutcome) — the
    // engine deprioritizes providers at their configured rate ceiling.
    getRate: (id) => runtime.getRate(id),
    // Concurrent in-flight turns (begin/settle around each send) — the
    // least-busy strategy's signal.
    getInFlight: (id) => runtime.getInFlight(id),

    // ---- Deployment granularity (providerId::modelId[::keyId] keys) ------
    getDeploymentHealth: (key) => runtime.getDeploymentHealth(key),
    getDeploymentCircuitBreakerState: (key) => runtime.getDeploymentCircuitBreakerState(key),
    getDeploymentRate: (key) => runtime.getDeploymentRate(key),
    getDeploymentInFlight: (key) => runtime.getDeploymentInFlight(key),
    // Session affinity (multi-turn stickiness; pinned by provider-telemetry).
    getSessionDeployment: (sessionId) =>
      runtime.getSessionDeployment(sessionId) ?? getSessionDeployment(sessionId),
    releaseSessionDeployment: (sessionId) => {
      runtime.releaseSessionDeployment(sessionId)
      releaseSessionDeployment(sessionId)
    },
    // Only installed when the host wired one. Absent → the engine's judge
    // branch is unreachable and routing stays purely deterministic.
    ...(runtime.judgeDifficulty ? { judgeDifficulty: runtime.judgeDifficulty } : {}),
    listCandidates: () => catalogSnapshot.candidates,
    getCapabilities: (id, modelId) => catalogSnapshot.capabilities.get(catalogKey(id, modelId)),
    isLocalProvider: (id) => isLocalProviderName(id as Parameters<typeof isLocalProviderName>[0]),
  }
}

/**
 * Assemble a routing engine over the given settings + live telemetry stores.
 *
 * `overrides` shallow-merges over the store-backed deps. The inbound gateway
 * uses it to fold its own in-flight counts into `getInFlight` — the renderer
 * stores only track chat-plane turns, so a gateway decision would otherwise
 * score every provider as idle.
 */
export function buildRoutingEngine(
  appSettings: RoutingEngineSettings,
  overrides?: Partial<RoutingEngineDeps>
): ProviderRoutingEngine {
  const registry = createMappingRegistry(appSettings.modelMappings ?? [])
  const routingConfig = appSettings.routingConfig ?? DEFAULT_ROUTING_CONFIG
  const deps = buildRoutingEngineDeps(appSettings)
  return new ProviderRoutingEngine(
    registry,
    routingConfig,
    overrides ? { ...deps, ...overrides } : deps
  )
}

/**
 * Push per-provider circuit-breaker overrides (`ProviderConstraint.
 * circuitConfig` — allowed_fails / cooldown_time analog) into the live
 * breaker store. Idempotent merge; called from the send path right before
 * the engine consults breaker state so settings changes apply without a
 * dedicated subscription.
 */
export function applyCircuitConfigOverrides(
  constraints: ReadonlyArray<import("@cognia/provider-types/model-mapping").ProviderConstraint>
): void {
  if (constraints.length === 0) return
  const runtime = getProviderRoutingRuntimeAdapters()
  for (const constraint of constraints) {
    if (constraint.enabled && constraint.circuitConfig) {
      runtime.updateCircuitConfig(constraint.providerId, constraint.circuitConfig)
    }
  }
}

/**
 * Hydrate the in-memory circuit-breaker store from the PERSISTED routing
 * config: global enable + defaults (`routingConfig.circuitBreaker`) first,
 * then per-provider overrides. Idempotent; called from the send path so
 * reliability routing survives reloads. An absent `circuitBreaker` block
 * leaves the store untouched (historical opt-in-off behavior).
 */
export function applyCircuitBreakerSettings(
  routingConfig: import("@cognia/provider-types/model-mapping").RoutingConfig
): void {
  const cb = routingConfig.circuitBreaker
  if (cb) {
    const runtime = getProviderRoutingRuntimeAdapters()
    const { enabled, ...config } = cb
    runtime.setCircuitBreakerEnabled(enabled)
    if (Object.keys(config).length > 0) runtime.setCircuitBreakerSettings(config)
  }
  applyCircuitConfigOverrides(routingConfig.providerConstraints)
}
