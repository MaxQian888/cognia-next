/**
 * Unified Logger System — framework-agnostic core (ADR-0068 E4).
 *
 * Provides a centralized, configurable logging system with:
 * - Structured JSON logging
 * - Multiple transports (console, IndexedDB, remote, OTel)
 * - Session and trace ID correlation
 * - Log sampling and rate limiting
 * - Async batching for performance
 *
 * The app-coupled pieces — bootstrap wiring, native/breadcrumb/agent-trace/
 * OTLP/Langfuse transports, crash-log export — stay in `lib/logging/`, whose
 * barrel re-exports this package, so `@/lib/logging` keeps the full surface
 * while package consumers depend only on the stable core.
 *
 * @example
 * ```typescript
 * import { logger, createLogger } from '@cognia/logging';
 *
 * // Use default app logger
 * logger.info('Application started');
 *
 * // Create module-specific logger
 * const authLogger = createLogger('auth');
 * authLogger.debug('User login attempt', { userId: '123' });
 *
 * // With trace ID for request correlation
 * import { logContext } from '@cognia/logging';
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
export {
  clearRecentErrorLogs,
  getRecentErrorLogs,
  getRecentErrorLogsSnapshot,
  subscribeRecentErrorLogs,
} from "./recent-errors"
export { installConsoleBridge, type InstallConsoleBridgeOptions } from "./console-bridge"

export {
  OBSERVABILITY_EVENT_V1_SCHEMA,
  observabilityEventToStructuredLogEntry,
  structuredLogEntryToObservabilityEvent,
  type ObservabilityCorrelation,
  type ObservabilityDelivery,
  type ObservabilityEventKind,
  type ObservabilityEventScope,
  type ObservabilityEventV1,
  type ObservabilityPayload,
  type ObservabilityPrivacy,
  type ObservabilityRuntime,
  type StructuredLogAdapterContext,
} from "./observability-event"

export {
  structuredLogEntriesToOtlpLogs,
  type OtlpLogAnyValue,
  type OtlpLogAttribute,
  type OtlpLogRecord,
  type OtlpLogResourceMetadata,
  type OtlpResourceLogs,
} from "./otlp-log-record"

export {
  OBSERVABILITY_GOLDEN_FIXTURES,
  maximalGoldenFixture,
  minimalGoldenFixture,
  type ObservabilityGoldenFixture,
} from "./observability-event-fixtures"

export {
  CLIENT_PRIVACY_MANIFEST_V1,
  applyObservabilityPrivacy,
  createLocalDebugCaptureSession,
  scanHighConfidenceCredentials,
  type ClientPrivacyManifest,
  type CredentialScanResult,
  type HighConfidenceCredentialFinding,
  type HighConfidenceCredentialKind,
  type LocalDebugCaptureSession,
  type PrivacyApplicationOptions,
} from "./privacy-manifest"

export {
  resolveCrashCapabilities,
  type CrashCapabilityMatrix,
  type CrashCapabilityProbe,
  type CrashCapabilityState,
  type CrashCapabilityStatus,
  type CrashPlatform,
} from "./crash-capabilities"

export {
  MemoryObservabilitySpoolStore,
  ObservabilitySpool,
  type ObservabilitySpoolEnqueueResult,
  type ObservabilitySpoolLimits,
  type ObservabilitySpoolRecord,
  type ObservabilitySpoolStats,
  type ObservabilitySpoolStore,
  type SpoolCapacityReason,
  type SpoolDrainOptions,
  type SpoolDrainResult,
} from "./spool"

export {
  IndexedDBObservabilitySpoolStore,
  type IndexedDBObservabilitySpoolStoreOptions,
} from "./transports/indexeddb-spool-store"

export {
  ObservabilitySpoolTransport,
  createObservabilitySpoolTransport,
  type ObservabilitySpoolTransportOptions,
} from "./transports/observability-spool-transport"

export {
  RECOVERY_ORDER,
  allEnabledCheckpointsPassed,
  automaticReloadsDisabled,
  checkpointFor,
  isRecoverySubsystem,
  nextCheckpoint,
  recentRecoveryAudit,
  recoveryProgress,
  recoverySuspect,
  requiresSafeShell,
  type CheckpointResult,
  type CheckpointStatus,
  type RecoveryAuditEntry,
  type RecoveryBoot,
  type RecoveryMode,
  type RecoveryProgress,
  type RecoveryStateV1,
  type RecoverySubsystem,
  type RecoverySuspect,
  type RendererReloadBudget,
} from "./recovery-state"

export {
  assembleDiagnosticIncident,
  transitionIncident,
  type AssembleDiagnosticIncidentInput,
  type DiagnosticIncident,
  type IncidentAttachment,
  type IncidentAttachmentInput,
  type IncidentAttachmentKind,
  type IncidentState,
  type IncidentTransition,
} from "./incident"

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

// Transport exports (framework-agnostic set; the app-coupled transports are
// re-exported by lib/logging/transports)
export {
  ConsoleTransport,
  createConsoleTransport,
  IndexedDBTransport,
  createIndexedDBTransport,
  RemoteTransport,
  createRemoteTransport,
  IndexedDBRemoteRetryQueueStore,
  createRemoteRetryQueueStore,
  sentryTransform,
  logglyTransform,
  type ConsoleTransportOptions,
  type IndexedDBTransportOptions,
  type RemoteTransportOptions,
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
  files: createLogger("files"),
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
  canvas: createLogger("canvas"),
  a2ui: createLogger("a2ui"),
  tray: createLogger("tray"),
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
