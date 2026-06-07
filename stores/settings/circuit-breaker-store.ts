"use client"

/**
 * Provider circuit-breaker store (ADR-0043 Phase 4).
 *
 * Per-DEPLOYMENT fault tolerance (`providerId::modelId[::keyId]` keys — see
 * `types/provider/deployment.ts`). `record{Success,Failure}` (from
 * `lib/claude/provider-telemetry.ts`) drive the pure FSM in
 * `lib/ai/providers/circuit-breaker-machine`; the routing engine drops a
 * deployment from rotation when its breaker is open, and provider-level reads
 * reduce across the provider's deployments (best state wins) so one tripped
 * model does not blackhole the whole provider. When `enabled` is false the
 * store is inert (records no-op, everything available) so reliability routing
 * is strictly opt-in. In-memory only (non-persisted).
 */

import { create } from "zustand"

import {
  currentStateValue,
  recordFailure as machineRecordFailure,
  recordSuccess as machineRecordSuccess,
} from "@/lib/ai/providers/circuit-breaker-machine"
import {
  deploymentKeyOf,
  DEPLOYMENT_MODEL_WILDCARD,
  providerIdOfDeploymentKey,
} from "@/types/provider/deployment"
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  INITIAL_CIRCUIT_BREAKER_STATE,
  type CircuitBreakerConfig,
  type CircuitBreakerRecordOptions,
  type CircuitBreakerStateValue,
  type CircuitBreakerStoreState,
  type ProviderCircuitBreaker,
} from "@/types/provider/circuit-breaker"

export type { CircuitBreakerConfig, CircuitBreakerStateValue }

/**
 * The store extends the canonical `CircuitBreakerStoreState` (record/getState/
 * isAvailable/reset/updateConfig) with the global enable flag + default config
 * the settings UI binds to.
 */
interface CircuitBreakerStore extends CircuitBreakerStoreState {
  enabled: boolean
  settings: CircuitBreakerConfig
  setEnabled: (enabled: boolean) => void
  setSettings: (patch: Partial<CircuitBreakerConfig>) => void
}

/** Store key for a record; unencodable ids fall back to the raw providerId. */
function deploymentKeyFor(providerId: string, opts?: CircuitBreakerRecordOptions): string {
  return (
    deploymentKeyOf({
      providerId,
      modelId: opts?.modelId ?? DEPLOYMENT_MODEL_WILDCARD,
      ...(opts?.keyId !== undefined ? { keyId: opts.keyId } : {}),
    }) ?? providerId
  )
}

function keyBelongsToProvider(key: string, providerId: string): boolean {
  return key === providerId || providerIdOfDeploymentKey(key) === providerId
}

function ensureBreaker(
  breakers: Record<string, ProviderCircuitBreaker>,
  deploymentKey: string,
  providerId: string,
  settings: CircuitBreakerConfig,
  providerConfigs: Record<string, Partial<CircuitBreakerConfig>>
): ProviderCircuitBreaker {
  return (
    breakers[deploymentKey] ?? {
      providerId,
      deploymentKey,
      config: { ...settings, ...providerConfigs[providerId] },
      state: { ...INITIAL_CIRCUIT_BREAKER_STATE },
    }
  )
}

const STATE_RANK: Record<CircuitBreakerStateValue, number> = {
  closed: 0,
  "half-open": 1,
  open: 2,
}

export const useCircuitBreakerStore = create<CircuitBreakerStore>((set, get) => ({
  enabled: false,
  settings: DEFAULT_CIRCUIT_BREAKER_CONFIG,
  breakers: {},
  providerConfigs: {},

  setEnabled: (enabled) => set({ enabled }),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  getState: (providerId) => {
    const s = get()
    const now = Date.now()
    // Best state across the provider's deployments wins (closed > half-open >
    // open): the provider stays routable while any of its models is healthy.
    let best: CircuitBreakerStateValue | null = null
    for (const b of Object.values(s.breakers)) {
      if (!keyBelongsToProvider(b.deploymentKey, providerId)) continue
      const v = currentStateValue(b.state, b.config, now)
      if (best === null || STATE_RANK[v] < STATE_RANK[best]) best = v
      if (best === "closed") break
    }
    return best ?? "closed"
  },

  getDeploymentState: (deploymentKey) => {
    const b = get().breakers[deploymentKey]
    if (!b) return "closed"
    return currentStateValue(b.state, b.config, Date.now())
  },

  isAvailable: (providerId) => {
    if (!get().enabled) return true
    return get().getState(providerId) !== "open"
  },

  isDeploymentAvailable: (deploymentKey) => {
    if (!get().enabled) return true
    return get().getDeploymentState(deploymentKey) !== "open"
  },

  recordSuccess: (providerId, opts) => {
    if (!get().enabled) return
    const key = deploymentKeyFor(providerId, opts)
    set((s) => {
      const b = ensureBreaker(s.breakers, key, providerId, s.settings, s.providerConfigs)
      const state = machineRecordSuccess(b.state, b.config, Date.now())
      return { breakers: { ...s.breakers, [key]: { ...b, state } } }
    })
  },

  recordFailure: (providerId, opts) => {
    if (!get().enabled) return
    const key = deploymentKeyFor(providerId, opts)
    set((s) => {
      const b = ensureBreaker(s.breakers, key, providerId, s.settings, s.providerConfigs)
      const state = machineRecordFailure(b.state, b.config, Date.now(), {
        retryAfterMs: opts?.retryAfterMs,
      })
      return { breakers: { ...s.breakers, [key]: { ...b, state } } }
    })
  },

  resetBreaker: (providerId) =>
    set((s) => {
      const breakers = { ...s.breakers }
      for (const [key, b] of Object.entries(s.breakers)) {
        if (!keyBelongsToProvider(key, providerId)) continue
        breakers[key] = { ...b, state: { ...INITIAL_CIRCUIT_BREAKER_STATE } }
      }
      return { breakers }
    }),

  resetAll: () => set({ breakers: {}, providerConfigs: {} }),

  updateConfig: (providerId, config) =>
    set((s) => {
      const merged = { ...s.providerConfigs[providerId], ...config }
      const breakers = { ...s.breakers }
      for (const [key, b] of Object.entries(s.breakers)) {
        if (!keyBelongsToProvider(key, providerId)) continue
        breakers[key] = { ...b, config: { ...b.config, ...config } }
      }
      return { breakers, providerConfigs: { ...s.providerConfigs, [providerId]: merged } }
    }),
}))
