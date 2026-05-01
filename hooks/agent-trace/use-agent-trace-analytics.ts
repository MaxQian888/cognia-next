"use client"

/**
 * Agent-trace analytics hook — no-op stub for cognia-next.
 *
 * Cognia ships a recorder-backed analytics layer that the chat-side
 * external-agent manager calls into to render the per-run health badge.
 * cognia-next has not migrated that observability stack yet, so this hook
 * exposes a contract-compatible no-op that always returns `null` for the
 * session summary. The manager guards on truthiness, so the badge simply
 * renders nothing until observability lands.
 *
 * Replace with a real implementation against `useAgentTraceStore` once the
 * recorder is migrated. See `lib/ai/agent/external/agent-trace-bridge.ts`
 * for the parallel bridge stub.
 */

import { useCallback } from "react"

import type { AgentTraceSessionAnalyticsSummary } from "@/types/agent/agent-trace"

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
  _options: UseAgentTraceAnalyticsOptions = {}
): UseAgentTraceAnalyticsResult {
  const refresh = useCallback(async () => {
    // Intentional no-op until observability lands.
  }, [])

  return {
    sessionSummary: null,
    isLoading: false,
    error: null,
    refresh,
  }
}
