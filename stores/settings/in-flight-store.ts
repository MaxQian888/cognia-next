/**
 * In-flight request tracker — the least-busy routing strategy's signal
 * (LiteLLM least-busy analog). Unlike the trailing-minute rate window
 * (reactive, post-turn), this counts CONCURRENT turns so the router can
 * avoid piling new requests onto a provider that is already serving.
 *
 * Counts are keyed per DEPLOYMENT (`providerId::modelId[::keyId]` — see
 * `types/provider/deployment.ts`); provider-level reads sum across the
 * provider's deployments so existing consumers keep working.
 *
 * Leak-proofing is structural: entries are keyed by sessionId, `begin`
 * auto-settles a session's previous entry (fallback retries re-issue the
 * same session), and `settle` is idempotent — `session_ended` of any
 * flavor (success, error, abort) settles unconditionally, so a count can
 * never stick past its turn.
 */

import { create } from "zustand"

import {
  deploymentKeyOf,
  DEPLOYMENT_MODEL_WILDCARD,
  providerIdOfDeploymentKey,
} from "@/types/provider/deployment"

/** Optional deployment targeting for `begin`. */
export interface InFlightBeginOptions {
  modelId?: string
  keyId?: string
}

interface InFlightState {
  /** sessionId → deployment key currently serving it. */
  bySession: Record<string, string>
  /** deployment key → number of concurrent turns. */
  counts: Record<string, number>
  /** Mark a session's turn as in flight against a provider/deployment. */
  begin: (sessionId: string, providerId: string, opts?: InFlightBeginOptions) => void
  /** Settle a session's turn (idempotent; unknown sessions are no-ops). */
  settle: (sessionId: string) => void
  /** Concurrent in-flight turns for a provider, summed across deployments. */
  getInFlight: (providerId: string) => number
  /** Concurrent in-flight turns for one deployment (0 = idle/unknown). */
  getDeploymentInFlight: (deploymentKey: string) => number
  __resetForTesting: () => void
}

/** Store key for a turn; unencodable ids fall back to the raw providerId. */
function deploymentKeyFor(providerId: string, opts?: InFlightBeginOptions): string {
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

function decremented(counts: Record<string, number>, key: string): Record<string, number> {
  const current = counts[key] ?? 0
  const next = { ...counts }
  if (current <= 1) {
    delete next[key]
  } else {
    next[key] = current - 1
  }
  return next
}

export const useInFlightStore = create<InFlightState>((set, get) => ({
  bySession: {},
  counts: {},

  begin: (sessionId, providerId, opts) => {
    if (!sessionId || !providerId) return
    const key = deploymentKeyFor(providerId, opts)
    set((state) => {
      // A re-issue (fallback retry) replaces the session's previous entry.
      const previous = state.bySession[sessionId]
      const counts = previous ? decremented(state.counts, previous) : { ...state.counts }
      counts[key] = (counts[key] ?? 0) + 1
      return {
        bySession: { ...state.bySession, [sessionId]: key },
        counts,
      }
    })
  },

  settle: (sessionId) => {
    if (!sessionId) return
    set((state) => {
      const key = state.bySession[sessionId]
      if (!key) return state
      const bySession = { ...state.bySession }
      delete bySession[sessionId]
      return { bySession, counts: decremented(state.counts, key) }
    })
  },

  getInFlight: (providerId) => {
    let total = 0
    for (const [key, count] of Object.entries(get().counts)) {
      if (keyBelongsToProvider(key, providerId)) total += count
    }
    return total
  },

  getDeploymentInFlight: (deploymentKey) => get().counts[deploymentKey] ?? 0,

  __resetForTesting: () => set({ bySession: {}, counts: {} }),
}))
