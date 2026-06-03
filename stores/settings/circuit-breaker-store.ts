"use client"

/**
 * Provider circuit-breaker store (ADR-0043 Phase 4).
 *
 * Per-provider fault tolerance. `record{Success,Failure}` (from
 * `lib/claude/provider-telemetry.ts`) drive the pure FSM in
 * `lib/ai/providers/circuit-breaker-machine`; the routing engine drops a
 * provider from rotation when `isAvailable` is false (breaker open). When
 * `enabled` is false the store is inert (records no-op, everything available)
 * so reliability routing is strictly opt-in. In-memory only (non-persisted).
 */

import { create } from "zustand"

import {
  currentStateValue,
  recordFailure as machineRecordFailure,
  recordSuccess as machineRecordSuccess,
} from "@/lib/ai/providers/circuit-breaker-machine"
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  INITIAL_CIRCUIT_BREAKER_STATE,
  type CircuitBreakerConfig,
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

function ensureBreaker(
  breakers: Record<string, ProviderCircuitBreaker>,
  providerId: string,
  settings: CircuitBreakerConfig
): ProviderCircuitBreaker {
  return (
    breakers[providerId] ?? {
      providerId,
      config: settings,
      state: { ...INITIAL_CIRCUIT_BREAKER_STATE },
    }
  )
}

export const useCircuitBreakerStore = create<CircuitBreakerStore>((set, get) => ({
  enabled: false,
  settings: DEFAULT_CIRCUIT_BREAKER_CONFIG,
  breakers: {},

  setEnabled: (enabled) => set({ enabled }),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  getState: (providerId) => {
    const b = get().breakers[providerId]
    if (!b) return "closed"
    return currentStateValue(b.state, b.config, Date.now())
  },

  isAvailable: (providerId) => {
    if (!get().enabled) return true
    return get().getState(providerId) !== "open"
  },

  recordSuccess: (providerId) => {
    if (!get().enabled) return
    set((s) => {
      const b = ensureBreaker(s.breakers, providerId, s.settings)
      const state = machineRecordSuccess(b.state, b.config, Date.now())
      return { breakers: { ...s.breakers, [providerId]: { ...b, state } } }
    })
  },

  recordFailure: (providerId) => {
    if (!get().enabled) return
    set((s) => {
      const b = ensureBreaker(s.breakers, providerId, s.settings)
      const state = machineRecordFailure(b.state, b.config, Date.now())
      return { breakers: { ...s.breakers, [providerId]: { ...b, state } } }
    })
  },

  resetBreaker: (providerId) =>
    set((s) => {
      const b = ensureBreaker(s.breakers, providerId, s.settings)
      return {
        breakers: {
          ...s.breakers,
          [providerId]: { ...b, state: { ...INITIAL_CIRCUIT_BREAKER_STATE } },
        },
      }
    }),

  resetAll: () => set({ breakers: {} }),

  updateConfig: (providerId, config) =>
    set((s) => {
      const b = ensureBreaker(s.breakers, providerId, s.settings)
      return {
        breakers: { ...s.breakers, [providerId]: { ...b, config: { ...b.config, ...config } } },
      }
    }),
}))
