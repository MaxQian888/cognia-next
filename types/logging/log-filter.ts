/**
 * Log Filter & Stats Types
 */

import type { LogLevel } from "./log-level"

/**
 * Log filter options
 */
export interface LogFilter {
  level?: LogLevel
  module?: string
  traceId?: string
  spanId?: string
  since?: Date
  until?: Date
  search?: string
  tags?: string[]
  limit?: number
  offset?: number
}

/**
 * Log statistics
 */
export interface LogStats {
  total: number
  byLevel: Record<LogLevel, number>
  byModule: Record<string, number>
  oldestEntry?: Date
  newestEntry?: Date
}
