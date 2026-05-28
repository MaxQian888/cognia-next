"use client"

/**
 * Per-session agent-trace analytics — driven by `useLiveQuery` over the
 * Dexie `agentTraces` table. Returns the existing
 * `AgentTraceSessionAnalyticsSummary` shape consumed by the chat-side
 * external-agent manager (it renders the per-run health badge from this).
 *
 * The hook auto-loads by default (matching the legacy stub's surface) and
 * exposes a `refresh()` no-op for callers that paginate elsewhere — Dexie
 * already pushes updates whenever the trace transport flushes a batch.
 */

import { useCallback } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import type { AgentTraceSessionAnalyticsSummary } from "@/types/agent/agent-trace"
import { aggregateBySession } from "@/lib/db/agent-traces"

export interface UseAgentTraceAnalyticsOptions {
  sessionId?: string | null
  autoLoad?: boolean
}

export interface UseAgentTraceAnalyticsResult {
  sessionSummary: AgentTraceSessionAnalyticsSummary | null
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useAgentTraceAnalytics(
  options: UseAgentTraceAnalyticsOptions = {}
): UseAgentTraceAnalyticsResult {
  const { sessionId, autoLoad = true } = options
  const sid = sessionId ?? null

  const summary = useLiveQuery(
    async () => {
      if (!autoLoad) return null
      if (!sid) return null
      return aggregateBySession(sid)
    },
    [sid, autoLoad],
    undefined as AgentTraceSessionAnalyticsSummary | null | undefined
  )

  const refresh = useCallback(async () => {
    // `useLiveQuery` already re-runs reactively when the underlying table
    // changes; explicit refresh is a no-op kept to satisfy the legacy
    // contract.
  }, [])

  return {
    sessionSummary: summary ?? null,
    isLoading: autoLoad && sid !== null && summary === undefined,
    error: null,
    refresh,
  }
}
