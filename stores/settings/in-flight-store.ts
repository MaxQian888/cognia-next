/**
 * In-flight request tracker — the least-busy routing strategy's signal
 * (LiteLLM least-busy analog). Unlike the trailing-minute rate window
 * (reactive, post-turn), this counts CONCURRENT turns so the router can
 * avoid piling new requests onto a provider that is already serving.
 *
 * Leak-proofing is structural: entries are keyed by sessionId, `begin`
 * auto-settles a session's previous entry (fallback retries re-issue the
 * same session), and `settle` is idempotent — `session_ended` of any
 * flavor (success, error, abort) settles unconditionally, so a count can
 * never stick past its turn.
 */

import { create } from "zustand"

interface InFlightState {
  /** sessionId → providerId currently serving it. */
  bySession: Record<string, string>
  /** providerId → number of concurrent turns. */
  counts: Record<string, number>
  /** Mark a session's turn as in flight against a provider. */
  begin: (sessionId: string, providerId: string) => void
  /** Settle a session's turn (idempotent; unknown sessions are no-ops). */
  settle: (sessionId: string) => void
  /** Concurrent in-flight turns for a provider (0 = idle/unknown). */
  getInFlight: (providerId: string) => number
  __resetForTesting: () => void
}

function decremented(counts: Record<string, number>, providerId: string): Record<string, number> {
  const current = counts[providerId] ?? 0
  const next = { ...counts }
  if (current <= 1) {
    delete next[providerId]
  } else {
    next[providerId] = current - 1
  }
  return next
}

export const useInFlightStore = create<InFlightState>((set, get) => ({
  bySession: {},
  counts: {},

  begin: (sessionId, providerId) => {
    if (!sessionId || !providerId) return
    set((state) => {
      // A re-issue (fallback retry) replaces the session's previous entry.
      const previous = state.bySession[sessionId]
      const counts = previous ? decremented(state.counts, previous) : { ...state.counts }
      counts[providerId] = (counts[providerId] ?? 0) + 1
      return {
        bySession: { ...state.bySession, [sessionId]: providerId },
        counts,
      }
    })
  },

  settle: (sessionId) => {
    if (!sessionId) return
    set((state) => {
      const providerId = state.bySession[sessionId]
      if (!providerId) return state
      const bySession = { ...state.bySession }
      delete bySession[sessionId]
      return { bySession, counts: decremented(state.counts, providerId) }
    })
  },

  getInFlight: (providerId) => get().counts[providerId] ?? 0,

  __resetForTesting: () => set({ bySession: {}, counts: {} }),
}))
