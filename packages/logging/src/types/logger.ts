/**
 * Logger Configuration & Instance Types
 */

import type { AppLogLevel, LogLevel } from "./log-level"
import {
  DEFAULT_REDACTION_KEYS,
  DEFAULT_REDACTION_PATTERNS,
  DEFAULT_REDACTION_REPLACEMENT,
} from "../redaction-patterns"

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
  /**
   * Run `fn` inside a new span. Logs emitted within `fn` carry the span's
   * `spanId` (and `parentSpanId` when nested); on completion a debug entry
   * named `name` is emitted with `phase: "end"` and the measured `durationMs`.
   */
  span<T>(name: string, fn: (logger: Logger) => T): T
  /** Async variant of {@link Logger.span}. */
  spanAsync<T>(name: string, fn: (logger: Logger) => Promise<T>): Promise<T>
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
  /**
   * Per-module minimum-level overrides. Keys are `:`-separated module prefixes
   * (e.g. `network`, `network:lark`); the most specific match wins, otherwise
   * `minLevel` applies. See `lib/logging/level-rules.ts`.
   */
  perModuleLevels?: Record<string, LogLevel>
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
  perModuleLevels: {},
  bufferSize: 100,
  flushInterval: 1000,
  redaction: {
    enabled: true,
    replacement: DEFAULT_REDACTION_REPLACEMENT,
    redactKeys: [...DEFAULT_REDACTION_KEYS],
    redactPatterns: [...DEFAULT_REDACTION_PATTERNS],
    maxDepth: 8,
  },
  remoteQueueMaxEntries: 5_000,
  remoteQueueMaxBytes: 10 * 1024 * 1024,
  diagnosticRateLimitMs: 2_000,
}

/**
 * Legacy logger config interface (originally lived in `@/types/system/logger`).
 */
export interface LoggerConfig {
  minLevel: AppLogLevel
  enableConsole: boolean
  enableStorage: boolean
  enableRemote: boolean
  remoteEndpoint?: string
  maxStorageEntries: number
  includeStackTrace: boolean
}

export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  minLevel: "info",
  enableConsole: true,
  enableStorage: false,
  enableRemote: false,
  maxStorageEntries: 1000,
  includeStackTrace: true,
}
