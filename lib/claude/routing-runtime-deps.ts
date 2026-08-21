/**
 * Routing runtime adapters — the bridge that reconnects the isolated
 * `@cognia/provider-routing` engine to the host's live in-memory stores.
 *
 * The routing package reads all reliability telemetry, today-spend, rate
 * windows, in-flight counts, session affinity, the difficulty-router settings
 * and the semantic-tool-router deps through `getProviderRoutingRuntimeAdapters()`
 * (`@cognia/provider-routing/runtime-adapters`). Until a host installs them via
 * `setProviderRoutingRuntimeAdapters`, those getters return inert defaults
 * (health `undefined`, breaker `"closed"`, spend `0`, …) and the engine silently
 * degrades to priority-order routing.
 *
 * This builder returns the store-backed implementation; the boot-time
 * `RoutingRuntimeInitializer` calls `setProviderRoutingRuntimeAdapters` with it
 * exactly once. Mirrors `lib/ai/agent/agent-team-runtime-deps.ts`.
 *
 * The write side that FEEDS these stores is `lib/claude/provider-telemetry.ts`
 * (`recordProviderOutcome`, run after every turn).
 */

import type { ProviderRoutingRuntimeAdapters } from "@cognia/provider-routing/runtime-adapters"
import {
  getSessionDeployment,
  releaseSessionDeployment,
} from "@cognia/provider-routing/session-affinity-store"
import { generateEmbeddings, type EmbeddingConfig } from "@cognia/provider-embedding/embedding"
import type { CircuitBreakerConfig } from "@cognia/provider-types/circuit-breaker"

import { useSettingsStore } from "@/stores/settings"
import { useHealthMetricsStore } from "@/stores/settings/health-metrics-store"
import { useCircuitBreakerStore } from "@/stores/settings/circuit-breaker-store"
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"
import { useRateLimitStore } from "@/stores/settings/rate-limit-store"
import { useInFlightStore } from "@/stores/settings/in-flight-store"
import { cacheToolRouteEmbeddings, listEnabledToolRoutes } from "@/lib/db/tool-routes"

/**
 * Build the live-store-backed routing runtime adapters. Every getter is a thin
 * synchronous read of a zustand store's `getState()` (or a direct affinity-store
 * call), so consulting them on the send hot path never awaits.
 *
 * `getHealthMetrics` / `getDeploymentHealth` deliberately return `undefined`
 * (not an empty rollup) for a never-recorded provider/deployment so the engine
 * keeps priority order until rolling stats accrue — the documented "no-info"
 * contract that `buildRoutingEngineDeps` relies on.
 */
export function buildRoutingRuntimeAdapters(): ProviderRoutingRuntimeAdapters {
  return {
    // ---- Health telemetry (raw read preserves the no-info `undefined`) -----
    getHealthMetrics: (providerId) => useHealthMetricsStore.getState().metrics[providerId],
    getDeploymentHealth: (deploymentKey) => {
      const store = useHealthMetricsStore.getState()
      if (!store.buckets[deploymentKey]) return undefined
      return store.getDeploymentMetrics(deploymentKey)
    },

    // ---- Circuit breaker (state + config sink) ----------------------------
    getCircuitBreakerState: (providerId) => useCircuitBreakerStore.getState().getState(providerId),
    isCircuitBreakerAvailable: (providerId) =>
      useCircuitBreakerStore.getState().isAvailable(providerId),
    getDeploymentCircuitBreakerState: (deploymentKey) =>
      useCircuitBreakerStore.getState().getDeploymentState(deploymentKey),
    setCircuitBreakerEnabled: (enabled) => useCircuitBreakerStore.getState().setEnabled(enabled),
    setCircuitBreakerSettings: (settings) =>
      useCircuitBreakerStore.getState().setSettings(settings as Partial<CircuitBreakerConfig>),
    updateCircuitConfig: (providerId, config) =>
      useCircuitBreakerStore
        .getState()
        .updateConfig(providerId, config as Partial<CircuitBreakerConfig>),

    // ---- Durable today-spend mirror (dailyCostBudget) ---------------------
    getTodaySpend: (providerId) => useProviderCostMirrorStore.getState().getTodaySpend(providerId),

    // ---- Trailing-minute rate windows (RPM/TPM) ---------------------------
    getRate: (providerId) => useRateLimitStore.getState().getRate(providerId),
    getDeploymentRate: (deploymentKey) =>
      useRateLimitStore.getState().getDeploymentRate(deploymentKey),

    // ---- Concurrent in-flight counters (least-busy) -----------------------
    getInFlight: (providerId) => useInFlightStore.getState().getInFlight(providerId),
    getDeploymentInFlight: (deploymentKey) =>
      useInFlightStore.getState().getDeploymentInFlight(deploymentKey),

    // ---- Multi-turn session affinity --------------------------------------
    getSessionDeployment: (sessionId) => getSessionDeployment(sessionId),
    releaseSessionDeployment: (sessionId) => releaseSessionDeployment(sessionId),

    // ---- Difficulty router settings (RouteLLM-lite; opt-in, off by default)
    getDifficultyRoutingSettings: () => useSettingsStore.getState().settings?.difficultyRouting,

    getAutoRoutingJudgeSettings: () => useSettingsStore.getState().settings?.autoRouting?.judge,

    // ---- Difficulty judge (opt-in INSIDE opted-in Auto routing) -----------
    //
    // Installed unconditionally; the settings gate lives in the engine, which
    // consults it only when `autoRouting.judge.enabled` is true AND the
    // deterministic score sits inside the uncertainty band. Building the
    // utility client lazily per call is deliberate: it is the user's own cheap
    // model, and resolving it at boot would freeze whatever was configured then.
    judgeDifficulty: async (input) => {
      const [{ judgeDifficulty }, { buildUtilityLlmClient }] = await Promise.all([
        import("@/lib/ai/routing/difficulty-judge"),
        import("@/lib/ai/generation/utility-client"),
      ])
      const settings = useSettingsStore.getState().settings
      const client = buildUtilityLlmClient({
        session: null,
        appSettings: settings,
        featureId: "routing-difficulty-judge",
      })
      if (!client) return null
      return judgeDifficulty(client, {
        promptText: input.promptText,
        deterministicTier: input.deterministicTier,
        ...(settings?.autoRouting?.judge?.timeoutMs !== undefined
          ? { timeoutMs: settings.autoRouting.judge.timeoutMs }
          : {}),
      })
    },

    // ---- Semantic tool router deps (opt-in, off by default) ----------------
    semanticToolRouterDeps: {
      listRoutes: () => listEnabledToolRoutes(),
      embed: async (texts, config) => {
        const result = await generateEmbeddings(texts, config as unknown as EmbeddingConfig)
        return result.embeddings
      },
      cacheRouteEmbeddings: (id, embeddings, model) =>
        cacheToolRouteEmbeddings(id, embeddings, model),
    },
  }
}
