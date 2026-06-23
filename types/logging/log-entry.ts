/**
 * Log Entry Types
 */

import type { AppLogLevel, LogLevel, LogOrigin, LogRuntime } from "./log-level"

/**
 * Structured log entry with full context
 */
export interface StructuredLogEntry {
  /** Unique log entry ID */
  id: string
  /** ISO timestamp */
  timestamp: string
  /** Log level */
  level: LogLevel
  /** Log message */
  message: string
  /** Module/component name */
  module: string
  /** Trace ID for request correlation */
  traceId?: string
  /** Request ID for operation correlation */
  requestId?: string
  /** Runtime execution ID */
  executionId?: string
  /** Workflow ID (if applicable) */
  workflowId?: string
  /** Workflow/runtime step ID */
  stepId?: string
  /** Structured runtime event ID */
  eventId?: string
  /** Machine-readable status/event code */
  code?: string
  /** Runtime source (browser/tauri/native/etc) */
  runtime?: LogRuntime
  /** Normalized origin classification for UI triage */
  origin?: LogOrigin
  /** Session ID */
  sessionId?: string
  /** Span ID for the operation this entry belongs to (see lib/logging/context.ts) */
  spanId?: string
  /** Parent span ID (the enclosing span), when nested */
  parentSpanId?: string
  /** Logical phase of the operation (e.g. "start", "end", "retry") */
  phase?: string
  /** Retry attempt counter (1-based) */
  attempt?: number
  /** Operation duration in milliseconds (stamped on span completion) */
  durationMs?: number
  /** Additional structured data */
  data?: Record<string, unknown>
  /** Error stack trace */
  stack?: string
  /** Source file and line (dev only) */
  source?: {
    file?: string
    line?: number
    function?: string
  }
  /** Tags for filtering */
  tags?: string[]
}

/**
 * Legacy log entry shape (originally lived in `@/types/system/logger` in Cognia).
 * Kept for backward compatibility.
 */
export interface LogEntry {
  id: string
  timestamp: Date
  level: AppLogLevel
  message: string
  data?: unknown
  context?: Record<string, unknown>
  stack?: string
  userId?: string
  sessionId?: string
}
