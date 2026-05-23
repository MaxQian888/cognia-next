/**
 * Transport Types
 */

import type { LogLevel } from "./log-level"
import type { LogEntry, StructuredLogEntry } from "./log-entry"

export type TransportHealthStatus = "healthy" | "degraded" | "offline"

export interface TransportHealthSnapshot {
  transport: string
  status: TransportHealthStatus
  queueDepth: number
  retryCount: number
  droppedEntries: number
  lastSuccessAt?: string
  lastFailureAt?: string
  lastError?: string
  updatedAt: string
}

export interface TransportDiagnosticEvent {
  code: string
  message: string
  level?: LogLevel
  data?: Record<string, unknown>
  sourceTransport?: string
}

/**
 * Transport interface for log output
 */
export interface Transport {
  /** Transport name for identification */
  name: string
  /** Log a single entry */
  log(entry: StructuredLogEntry): void | Promise<void>
  /** Flush buffered entries */
  flush?(): void | Promise<void>
  /** Close and cleanup */
  close?(): void | Promise<void>
  /** Report transport health snapshot */
  getHealth?(): TransportHealthSnapshot
  /** Optional sync pending count for lightweight polling */
  getPendingCount?(): number
}

/**
 * Legacy transport interface (originally lived in `@/types/system/logger`).
 */
export interface LogTransport {
  name: string
  log: (entry: LogEntry) => void | Promise<void>
  flush?: () => void | Promise<void>
}
