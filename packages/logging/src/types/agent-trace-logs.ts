/**
 * Agent-Trace Log Hook Types
 */

import type { StructuredLogEntry } from "./log-entry"

export interface UseAgentTraceLogsOptions {
  enabled?: boolean
  maxLogs?: number
  includeHistory?: boolean
  /**
   * Follow the trace table live (default `true`). With `false` the hook hands
   * back a snapshot taken when following stopped and only re-reads it when
   * `refreshToken` changes — the log panel's "Live off" must freeze every row
   * it shows, and the span rows used to keep streaming in under a paused list.
   */
  live?: boolean
  /** Bump to re-snapshot while `live` is `false` (manual refresh). */
  refreshToken?: number
}

export interface UseAgentTraceLogsReturn {
  logs: StructuredLogEntry[]
  isLoading: boolean
  error: Error | null
}
