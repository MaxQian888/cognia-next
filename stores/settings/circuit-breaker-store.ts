"use client"

/**
 * Stub: provider circuit-breaker store.
 *
 * Cognia ships a fault-tolerance store backing per-provider circuit
 * breakers. Reliability infrastructure was deferred from cognia-next's
 * provider port (see plan §scope decision). This stub returns a
 * permanently-closed breaker so the UI tabs render an "OK" state
 * without crashing.
 */

import { create } from "zustand"
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  INITIAL_CIRCUIT_BREAKER_STATE,
  type CircuitBreakerConfig,
  type CircuitBreakerState as CircuitBreakerLifecycleState,
  type CircuitBreakerStateValue,
} from "@/types/provider/circuit-breaker"

export type { CircuitBreakerConfig, CircuitBreakerStateValue }

interface CircuitBreakerStoreState {
  enabled: boolean
  settings: CircuitBreakerConfig
  breakers: Record<string, CircuitBreakerLifecycleState>
  getBreaker: (providerId: string) => CircuitBreakerLifecycleState
  setEnabled: (enabled: boolean) => void
  setSettings: (patch: Partial<CircuitBreakerConfig>) => void
  reset: (providerId: string) => void
}

export const useCircuitBreakerStore = create<CircuitBreakerStoreState>((set, get) => ({
  enabled: false,
  settings: DEFAULT_CIRCUIT_BREAKER_CONFIG,
  breakers: {},
  getBreaker: (providerId) => get().breakers[providerId] ?? INITIAL_CIRCUIT_BREAKER_STATE,
  setEnabled: (enabled) => set({ enabled }),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  reset: (providerId) => {
    set((s) => {
      const next = { ...s.breakers }
      delete next[providerId]
      return { breakers: next }
    })
  },
}))
