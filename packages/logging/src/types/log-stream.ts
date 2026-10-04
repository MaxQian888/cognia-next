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
}

export interface LogStreamResult {
  logs: StructuredLogEntry[]
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
  /**
   * Whether the store returned as many entries as `maxLogs` allowed, measured
   * BEFORE the client-side search narrowed them. A search that leaves twelve
   * rows out of a full window still only searched the newest `maxLogs`
   * entries; computing this from the filtered length made the "window full"
   * warning vanish exactly when it mattered.
   */
  windowCapped: boolean
}
