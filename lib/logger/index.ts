/**
 * Unified Logger System
 *
 * Provides a centralized, configurable logging system with:
 * - Structured JSON logging
 * - Multiple transports (console, IndexedDB, remote)
 * - Session and trace ID correlation
 * - Log sampling and rate limiting
 * - Async batching for performance
 *
 * @example
 * ```typescript
 * import { logger, createLogger } from '@/lib/logger';
 *
 * // Use default app logger
 * logger.info('Application started');
 *
 * // Create module-specific logger
 * const authLogger = createLogger('auth');
 * authLogger.debug('User login attempt', { userId: '123' });
 *
 * // With trace ID for request correlation
 * import { logContext } from '@/lib/logger';
 * logContext.newTraceId();
 * logger.info('Processing request');
 * ```
 */

// Core exports
export {
  createLogger,
  initLogger,
  addTransport,
  removeTransport,
  getTransport,
  getTransports,
  getTransportHealth,
  getTransportHealthSnapshot,
  emitLoggerDiagnostic,
  updateLoggerConfig,
  getLoggerConfig,
  getRegisteredModules,
  getLoggerStats,
  flushLogs,
  shutdownLogger,
} from "./core"
export { clearRecentErrorLogs, getRecentErrorLogs, subscribeRecentErrorLogs } from "./recent-errors"

// Bootstrap exports
export {
  bootstrapLogger,
  applyLoggingSettings,
  getLoggingBootstrapState,
  getIndexedDBTransport,
  listRegisteredTransports,
  LOGGING_TRANSPORTS_STORAGE_KEY,
  LOGGING_RETENTION_STORAGE_KEY,
  LOGGING_SAMPLING_STORAGE_KEY,
  type LoggingBootstrapState,
  type LoggingRetentionSettings,
  type LoggingTransportSettings,
} from "./bootstrap"

// Context exports
export { logContext, generateTraceId, traced } from "./context"

export {
  createLogRuntimeContext,
  normalizeLogOrigin,
  normalizeLogRuntime,
  withLogRuntimeContext,
} from "./runtime"

// Sampling exports
export { logSampler, configureSampling, samplingRate } from "./sampling"

// Type exports
export type {
  Logger,
  LogLevel,
  LogOrigin,
  LogRuntime,
  StructuredLogEntry,
  Transport,
  TransportHealthStatus,
  TransportHealthSnapshot,
  TransportDiagnosticEvent,
  UnifiedLoggerConfig,
  LoggerRedactionConfig,
  LogFilter,
  LogStats,
} from "./types"

export { LEVEL_PRIORITY, DEFAULT_UNIFIED_CONFIG } from "./types"

// Transport exports
export {
  ConsoleTransport,
  createConsoleTransport,
  IndexedDBTransport,
  createIndexedDBTransport,
  RemoteTransport,
  createRemoteTransport,
  NativeTransport,
  createNativeTransport,
  IndexedDBRemoteRetryQueueStore,
  createRemoteRetryQueueStore,
  sentryTransform,
  logglyTransform,
  type ConsoleTransportOptions,
  type IndexedDBTransportOptions,
  type RemoteTransportOptions,
  type NativeTransportOptions,
  type RemoteRetryQueueStore,
  type RemoteRetryQueueBatch,
  type RemoteRetryQueueStats,
  type RemoteRetryQueueLimits,
  type RemoteRetryQueueEnqueueResult,
} from "./transports"

// Re-export legacy types for backward compatibility
export type { AppLogLevel, LogEntry, LoggerConfig, LogTransport } from "./types"

/**
 * Default application logger
 */
import { createLogger } from "./core"
export const logger = createLogger("app")

/**
 * Create pre-configured module loggers
 */
export const loggers = {
  app: logger,
  ai: createLogger("ai"),
  chat: createLogger("chat"),
  agent: createLogger("agent"),
  mcp: createLogger("mcp"),
  plugin: createLogger("plugin"),
  native: createLogger("native"),
  ui: createLogger("ui"),
  store: createLogger("store"),
  network: createLogger("network"),
  auth: createLogger("auth"),
  error: createLogger("error"),
  media: createLogger("media"),
  scheduler: createLogger("scheduler"),
  search: createLogger("search"),
  document: createLogger("document"),
  export: createLogger("export"),
  skills: createLogger("skills"),
  sync: createLogger("sync"),
  screenshot: createLogger("screenshot"),
  tts: createLogger("tts"),
  shell: createLogger("shell"),
}

/**
 * Quick logging functions (use default app logger)
 */
export const log = {
  trace: (message: string, data?: Record<string, unknown>) => logger.trace(message, data),
  debug: (message: string, data?: Record<string, unknown>) => logger.debug(message, data),
  info: (message: string, data?: Record<string, unknown>) => logger.info(message, data),
  warn: (message: string, data?: Record<string, unknown>) => logger.warn(message, data),
  error: (message: string, error?: Error | unknown, data?: Record<string, unknown>) =>
    logger.error(message, error, data),
  fatal: (message: string, error?: Error | unknown, data?: Record<string, unknown>) =>
    logger.fatal(message, error, data),
}
