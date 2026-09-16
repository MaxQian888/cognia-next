/**
 * The Router + Fusion cascade or panel run in flight in each conversation
 * (ADR-0188 B3, D7/D23).
 *
 * A fusion turn is verified_buffered: nothing is shown until the answer has
 * been checked. The progress card above the composer reads this store so the
 * wait is not a blank; the controller writes it while the run executes and
 * clears it when the turn settles. Transient by design: the run's journal is
 * the record, and a reload shows the sealed answer's own run card instead.
 * Empty, and never written, while Router + Fusion chat is off.
 */

import { create } from "zustand"
import type { RouterFusionRunSummary } from "@cognia/agent-config-types"

export interface FusionProgressEntry {
  runId: string
  mode: "cascade" | "panel"
  startedAt: number
  capMicrousd: number
  /** The run's latest journal fold; `null` until the first one arrives. */
  summary: RouterFusionRunSummary | null
}

export interface FusionProgressState {
  bySession: Record<string, FusionProgressEntry>
  start: (sessionId: string, entry: Omit<FusionProgressEntry, "summary">) => void
  /** A fold for a run the session is no longer on is dropped. */
  update: (sessionId: string, summary: RouterFusionRunSummary) => void
  /** Clear the session, or only when it is still on `runId`. */
  clear: (sessionId: string, runId?: string) => void
}

export const useFusionProgressStore = create<FusionProgressState>()((set) => ({
  bySession: {},
  start: (sessionId, entry) =>
    set((state) => ({
      bySession: { ...state.bySession, [sessionId]: { ...entry, summary: null } },
    })),
  update: (sessionId, summary) =>
    set((state) => {
      const current = state.bySession[sessionId]
      if (!current || current.runId !== summary.runId) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...current, summary } } }
    }),
  clear: (sessionId, runId) =>
    set((state) => {
      const current = state.bySession[sessionId]
      if (!current || (runId !== undefined && current.runId !== runId)) return state
      const bySession = { ...state.bySession }
      delete bySession[sessionId]
      return { bySession }
    }),
}))

export function useFusionProgress(
  sessionId: string | null | undefined
): FusionProgressEntry | null {
  return useFusionProgressStore((state) =>
    sessionId ? (state.bySession[sessionId] ?? null) : null
  )
}
