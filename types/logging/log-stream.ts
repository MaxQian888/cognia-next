/**
 * Log Stream Hook Types
 */

import type { LogLevel } from "./log-level"
import type { StructuredLogEntry } from "./log-entry"

export interface LogStreamOptions {
  /** Enable auto-refresh polling */
  autoRefresh?: boolean
  /** Refresh interval in milliseconds */
  refreshInterval?: number
  /** Maximum number of logs to keep in memory */
  maxLogs?: number
  /** Filter by log level */
  level?: LogLevel | "all"
  /** Filter by module name */
  module?: string
  /** Filter by trace ID */
  traceId?: string
  /** Search query for message content */
  searchQuery?: string
  /** Use regex for search query */
  useRegex?: boolean
  /** Filter by tags */
  tags?: string[]
  /** Group logs by trace ID */
  groupByTraceId?: boolean
}

export interface LogStreamResult {
  logs: StructuredLogEntry[]
  groupedLogs: Map<string, StructuredLogEntry[]>
  isLoading: boolean
  error: Error | null
  refresh: () => Promise<void>
  clearLogs: () => Promise<void>
  exportLogs: (format?: "json" | "text") => string
  stats: {
    total: number
    byLevel: Record<LogLevel, number>
    byModule: Record<string, number>
    oldestEntry?: Date
    newestEntry?: Date
  }
  logRate: number
}
