/**
 * Agent-Trace Log Hook Types
 */

import type { StructuredLogEntry } from "./log-entry"

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
