/**
 * useAgentTraceAsLogs — stub.
 *
 * Cognia merges agent-trace events into the unified log panel via this hook.
 * cognia-next has no agent-trace subsystem yet, so we expose the same surface
 * but always return an empty list. Fill this in (or replace with the real
 * Cognia hook) when an agent-trace store + Dexie persistence ship here.
 */

import type { StructuredLogEntry } from "@/lib/logger"

export interface UseAgentTraceLogsOptions {
  enabled?: boolean
  maxLogs?: number
  includeHistory?: boolean
}

export interface UseAgentTraceLogsReturn {
  logs: StructuredLogEntry[]
  isLoading: boolean
  error: Error | null
}

const EMPTY: StructuredLogEntry[] = []

export function useAgentTraceAsLogs(
  _options: UseAgentTraceLogsOptions = {}
): UseAgentTraceLogsReturn {
  return { logs: EMPTY, isLoading: false, error: null }
}

export default useAgentTraceAsLogs
