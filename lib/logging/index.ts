/**
 * Unified Logger System — app barrel (ADR-0068 E4).
 *
 * The framework-agnostic core (logger registry, context, sampling, redaction,
 * console/IndexedDB/remote/OTel transports, `logger`/`loggers`/`log`
 * singletons) lives in `@cognia/logging`; this barrel re-exports it plus the
 * app-coupled surface that stays here — bootstrap wiring, the native/
 * breadcrumb/agent-trace/OTLP/Langfuse transports, and the crash-log types.
 * Existing `@/lib/logging` importers keep the exact pre-extraction surface;
 * new code that only needs the core should import `@cognia/logging` directly
 * so its module graph stays off the app-side bootstrap.
 */

export * from "@cognia/logging"

// Bootstrap exports (app-side: native-logging + settings-store wiring)
export {
  bootstrapLogger,
  applyLoggingSettings,
  getLoggingBootstrapState,
  getIndexedDBTransport,
  listRegisteredTransports,
  LOGGING_TRANSPORTS_STORAGE_KEY,
  LOGGING_RETENTION_STORAGE_KEY,
  LOGGING_SAMPLING_STORAGE_KEY,
  DEFAULT_TRANSPORT_SETTINGS,
  DEFAULT_RETENTION_SETTINGS,
  RETENTION_BOUNDS,
  CONFIG_BOUNDS,
  RECOMMENDED_SAMPLING_RATES,
  type LoggingBootstrapState,
  type LoggingRetentionSettings,
  type LoggingTransportSettings,
} from "./bootstrap"

// App-coupled transports (native bridge, crash breadcrumbs, agent-trace
// Dexie sink, OTLP with PII redaction, Langfuse client)
export {
  NativeTransport,
  createNativeTransport,
  type NativeTransportOptions,
  LangfuseTransport,
  createLangfuseTransport,
  type LangfuseTransportOptions,
  BreadcrumbTransport,
  createBreadcrumbTransport,
  type BreadcrumbTransportOptions,
  AgentTraceTransport,
  createAgentTraceTransport,
  type AgentTraceTransportOptions,
  OtlpHttpTransport,
  createOtlpHttpTransport,
  type OtlpHttpTransportOptions,
} from "./transports"
