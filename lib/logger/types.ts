/**
 * Logger Types
 * Unified type definitions for the logging system
 */

// Legacy type surface (originally lived in `@/types/system/logger` in Cognia).
// Inlined here so the unified-logger package is self-contained.
export type AppLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

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

export interface LoggerConfig {
  minLevel: AppLogLevel
  enableConsole: boolean
  enableStorage: boolean
  enableRemote: boolean
  remoteEndpoint?: string
  maxStorageEntries: number
  includeStackTrace: boolean
}

export interface LogTransport {
  name: string
  log: (entry: LogEntry) => void | Promise<void>
  flush?: () => void | Promise<void>
}

export const LOG_LEVEL_PRIORITY: Record<AppLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  minLevel: "info",
  enableConsole: true,
  enableStorage: false,
  enableRemote: false,
  maxStorageEntries: 1000,
  includeStackTrace: true,
}

/**
 * Extended log levels with trace support
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"
export type LogRuntime = "browser" | "server" | "tauri" | "mcp" | "plugin" | "internal" | "unknown"
export type LogOrigin =
  | "frontend"
  | "web-runtime"
  | "tauri"
  | "mcp"
  | "plugin"
  | "diagnostic"
  | "unknown"

/**
 * Log level priority mapping (higher = more severe)
 */
export const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

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
 * Redaction configuration
 */
export interface LoggerRedactionConfig {
  /** Enable redaction before dispatching to transports */
  enabled: boolean
  /** Replacement token for redacted values */
  replacement: string
  /** Case-insensitive key patterns that should be redacted */
  redactKeys: string[]
  /** Text patterns (as regex strings) that should be redacted */
  redactPatterns: string[]
  /** Maximum object traversal depth for recursive redaction */
  maxDepth: number
}

/**
 * Logger configuration with advanced options
 */
export interface UnifiedLoggerConfig {
  /** Minimum log level to output */
  minLevel: LogLevel
  /** Enable console output */
  enableConsole: boolean
  /** Enable localStorage/IndexedDB storage */
  enableStorage: boolean
  /** Enable remote log shipping */
  enableRemote: boolean
  /** Remote endpoint URL */
  remoteEndpoint?: string
  /** Maximum entries to store locally */
  maxStorageEntries: number
  /** Include stack traces for errors */
  includeStackTrace: boolean
  /** Include source location (dev only) */
  includeSource: boolean
  /** Sampling configuration by module */
  sampling?: Record<string, number>
  /** Buffer size for batch operations */
  bufferSize: number
  /** Flush interval in milliseconds */
  flushInterval: number
  /** Redaction configuration */
  redaction: LoggerRedactionConfig
  /** Max entries allowed in durable remote retry queue */
  remoteQueueMaxEntries: number
  /** Max serialized bytes allowed in durable remote retry queue */
  remoteQueueMaxBytes: number
  /** Minimum interval for emitting repeated logger diagnostics */
  diagnosticRateLimitMs: number
}

/**
 * Default unified logger configuration
 */
export const DEFAULT_UNIFIED_CONFIG: UnifiedLoggerConfig = {
  minLevel: process.env.NODE_ENV === "production" ? "info" : "debug",
  enableConsole: true,
  enableStorage: true,
  enableRemote: false,
  maxStorageEntries: 5000,
  includeStackTrace: true,
  includeSource: process.env.NODE_ENV === "development",
  bufferSize: 100,
  flushInterval: 1000,
  redaction: {
    enabled: true,
    replacement: "[REDACTED]",
    redactKeys: [
      "password",
      "passwd",
      "pwd",
      "token",
      "access_token",
      "refresh_token",
      "secret",
      "api_key",
      "apikey",
      "authorization",
      "cookie",
      "session",
      "client_secret",
      "private_key",
      "bearer",
    ],
    redactPatterns: [
      // Generic bearer/JWT-like token fragments
      "Bearer\\s+[A-Za-z0-9\\-._~+/]+=*",
      // API key style assignments
      "(api[_-]?key|token|secret)\\s*[:=]\\s*[A-Za-z0-9\\-._~+/=]{8,}",
    ],
    maxDepth: 8,
  },
  remoteQueueMaxEntries: 5_000,
  remoteQueueMaxBytes: 10 * 1024 * 1024,
  diagnosticRateLimitMs: 2_000,
}

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
 * Logger instance interface
 */
export interface Logger {
  trace(message: string, data?: Record<string, unknown>): void
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void
  fatal(message: string, error?: Error | unknown, data?: Record<string, unknown>): void
  child(module: string): Logger
  withContext(context: Record<string, unknown>): Logger
  setTraceId(traceId: string): void
}

/**
 * Log filter options
 */
export interface LogFilter {
  level?: LogLevel
  module?: string
  traceId?: string
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
