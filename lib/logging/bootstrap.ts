import {
  addTransport,
  emitLoggerDiagnostic,
  getLoggerConfig,
  getTransport,
  getTransports,
  initLogger,
  removeTransport,
  updateLoggerConfig,
} from "./core"
import { DEFAULT_UNIFIED_CONFIG } from "@/types/logging"
import type {
  LogLevel,
  UnifiedLoggerConfig,
  RemoteTransportDetailSettings,
  LangfuseTransportDetailSettings,
  OpenTelemetryTransportDetailSettings,
  NativeTransportDetailSettings,
  LoggingTransportSettings,
  LoggingRetentionSettings,
  LoggingBootstrapState,
} from "@/types/logging"
import { configureSampling } from "./sampling"
import {
  createConsoleTransport,
  createIndexedDBTransport,
  createLangfuseTransport,
  createNativeTransport,
  createOtelTransport,
  createRemoteTransport,
  IndexedDBTransport,
} from "./transports"
import { setPlatformLoggingConfig } from "@/lib/native/native-logging"

export type {
  RemoteTransportDetailSettings,
  LangfuseTransportDetailSettings,
  OpenTelemetryTransportDetailSettings,
  NativeTransportDetailSettings,
  LoggingTransportSettings,
  LoggingRetentionSettings,
  LoggingBootstrapState,
} from "@/types/logging"

export const LOGGING_TRANSPORTS_STORAGE_KEY = "cognia-logging-transports"
export const LOGGING_RETENTION_STORAGE_KEY = "cognia-logging-retention"
export const LOGGING_CONFIG_STORAGE_KEY = "cognia-logging-config"
export const LOGGING_SAMPLING_STORAGE_KEY = "cognia-logging-sampling"

// All 6 transports enabled by default per the Phase-6 product decision.
// Remote / Langfuse / OpenTelemetry short-circuit silently when their
// credentials/endpoints are blank — see `applyTransportSettings()` below
// which gates remote attachment on a non-empty endpoint, the Langfuse
// transport which lazy-loads + no-ops on missing keys, and the OTel
// transport which guards POST against unreachable endpoints. Their
// `enabled` flag stays true so the panel surfaces a `Degraded` health
// badge until the user fills in the config in Settings → Observability.
const DEFAULT_TRANSPORT_SETTINGS: LoggingTransportSettings = {
  console: true,
  indexedDB: true,
  native: true,
  remote: true,
  langfuse: true,
  opentelemetry: true,
  nativeConfig: {
    minLevel: "warn",
    batchSize: 10,
    flushInterval: 2000,
  },
  remoteConfig: {
    endpoint: "",
    batchSize: 50,
    flushInterval: 5000,
    maxRetries: 3,
    retryDelay: 1000,
  },
  langfuseConfig: {
    publicKey: "",
    secretKey: "",
    host: "https://cloud.langfuse.com",
    minLevel: "warn",
  },
  opentelemetryConfig: {
    endpoint: "",
    serviceName: "cognia-ai",
    addAsSpanEvents: true,
  },
}

const DEFAULT_RETENTION_SETTINGS: LoggingRetentionSettings = {
  maxEntries: 10_000,
  maxAgeDays: 7,
}

const VALID_LOG_LEVELS: ReadonlySet<LogLevel> = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
])

let hasBootstrapped = false
let currentState: LoggingBootstrapState | null = null

function readStorageJSON<T>(key: string): Partial<T> | null {
  if (typeof window === "undefined") {
    return null
  }

  const raw = localStorage.getItem(key)
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw) as Partial<T>
  } catch {
    return null
  }
}

function readTransportSettings(): LoggingTransportSettings {
  const raw = readStorageJSON<LoggingTransportSettings>(LOGGING_TRANSPORTS_STORAGE_KEY)
  if (!raw) {
    return {
      ...DEFAULT_TRANSPORT_SETTINGS,
      nativeConfig: { ...DEFAULT_TRANSPORT_SETTINGS.nativeConfig },
      remoteConfig: { ...DEFAULT_TRANSPORT_SETTINGS.remoteConfig },
      langfuseConfig: { ...DEFAULT_TRANSPORT_SETTINGS.langfuseConfig },
      opentelemetryConfig: { ...DEFAULT_TRANSPORT_SETTINGS.opentelemetryConfig },
    }
  }

  const remoteConfig: Partial<RemoteTransportDetailSettings> =
    raw.remoteConfig && typeof raw.remoteConfig === "object"
      ? (raw.remoteConfig as Partial<RemoteTransportDetailSettings>)
      : {}
  const nativeConfig: Partial<NativeTransportDetailSettings> =
    raw.nativeConfig && typeof raw.nativeConfig === "object"
      ? (raw.nativeConfig as Partial<NativeTransportDetailSettings>)
      : {}
  const langfuseConfig: Partial<LangfuseTransportDetailSettings> =
    raw.langfuseConfig && typeof raw.langfuseConfig === "object"
      ? (raw.langfuseConfig as Partial<LangfuseTransportDetailSettings>)
      : {}
  const opentelemetryConfig: Partial<OpenTelemetryTransportDetailSettings> =
    raw.opentelemetryConfig && typeof raw.opentelemetryConfig === "object"
      ? (raw.opentelemetryConfig as Partial<OpenTelemetryTransportDetailSettings>)
      : {}

  return {
    console: typeof raw.console === "boolean" ? raw.console : DEFAULT_TRANSPORT_SETTINGS.console,
    indexedDB:
      typeof raw.indexedDB === "boolean" ? raw.indexedDB : DEFAULT_TRANSPORT_SETTINGS.indexedDB,
    native: typeof raw.native === "boolean" ? raw.native : DEFAULT_TRANSPORT_SETTINGS.native,
    remote: typeof raw.remote === "boolean" ? raw.remote : DEFAULT_TRANSPORT_SETTINGS.remote,
    langfuse:
      typeof raw.langfuse === "boolean" ? raw.langfuse : DEFAULT_TRANSPORT_SETTINGS.langfuse,
    opentelemetry:
      typeof raw.opentelemetry === "boolean"
        ? raw.opentelemetry
        : DEFAULT_TRANSPORT_SETTINGS.opentelemetry,
    nativeConfig: {
      minLevel:
        typeof nativeConfig.minLevel === "string" &&
        VALID_LOG_LEVELS.has(nativeConfig.minLevel as LogLevel)
          ? (nativeConfig.minLevel as LogLevel)
          : DEFAULT_TRANSPORT_SETTINGS.nativeConfig.minLevel,
      batchSize: clampNumber(
        nativeConfig.batchSize,
        1,
        100,
        DEFAULT_TRANSPORT_SETTINGS.nativeConfig.batchSize
      ),
      flushInterval: clampNumber(
        nativeConfig.flushInterval,
        250,
        30_000,
        DEFAULT_TRANSPORT_SETTINGS.nativeConfig.flushInterval
      ),
    },
    remoteConfig: {
      endpoint:
        typeof remoteConfig.endpoint === "string"
          ? remoteConfig.endpoint
          : DEFAULT_TRANSPORT_SETTINGS.remoteConfig.endpoint,
      batchSize: clampNumber(
        remoteConfig.batchSize,
        10,
        200,
        DEFAULT_TRANSPORT_SETTINGS.remoteConfig.batchSize
      ),
      flushInterval: clampNumber(
        remoteConfig.flushInterval,
        1000,
        30_000,
        DEFAULT_TRANSPORT_SETTINGS.remoteConfig.flushInterval
      ),
      maxRetries: clampNumber(
        remoteConfig.maxRetries,
        0,
        10,
        DEFAULT_TRANSPORT_SETTINGS.remoteConfig.maxRetries
      ),
      retryDelay: clampNumber(
        remoteConfig.retryDelay,
        500,
        10_000,
        DEFAULT_TRANSPORT_SETTINGS.remoteConfig.retryDelay
      ),
    },
    langfuseConfig: {
      publicKey:
        typeof langfuseConfig.publicKey === "string"
          ? langfuseConfig.publicKey
          : DEFAULT_TRANSPORT_SETTINGS.langfuseConfig.publicKey,
      secretKey:
        typeof langfuseConfig.secretKey === "string"
          ? langfuseConfig.secretKey
          : DEFAULT_TRANSPORT_SETTINGS.langfuseConfig.secretKey,
      host:
        typeof langfuseConfig.host === "string" && langfuseConfig.host.trim().length > 0
          ? langfuseConfig.host
          : DEFAULT_TRANSPORT_SETTINGS.langfuseConfig.host,
      minLevel:
        typeof langfuseConfig.minLevel === "string" &&
        VALID_LOG_LEVELS.has(langfuseConfig.minLevel as LogLevel)
          ? (langfuseConfig.minLevel as LogLevel)
          : DEFAULT_TRANSPORT_SETTINGS.langfuseConfig.minLevel,
    },
    opentelemetryConfig: {
      endpoint:
        typeof opentelemetryConfig.endpoint === "string" &&
        opentelemetryConfig.endpoint.trim().length > 0
          ? opentelemetryConfig.endpoint
          : DEFAULT_TRANSPORT_SETTINGS.opentelemetryConfig.endpoint,
      serviceName:
        typeof opentelemetryConfig.serviceName === "string" &&
        opentelemetryConfig.serviceName.trim().length > 0
          ? opentelemetryConfig.serviceName
          : DEFAULT_TRANSPORT_SETTINGS.opentelemetryConfig.serviceName,
      addAsSpanEvents:
        typeof opentelemetryConfig.addAsSpanEvents === "boolean"
          ? opentelemetryConfig.addAsSpanEvents
          : DEFAULT_TRANSPORT_SETTINGS.opentelemetryConfig.addAsSpanEvents,
    },
  }
}

function readRetentionSettings(): LoggingRetentionSettings {
  const raw = readStorageJSON<LoggingRetentionSettings>(LOGGING_RETENTION_STORAGE_KEY)
  return { ...DEFAULT_RETENTION_SETTINGS, ...(raw || {}) }
}

function readSamplingSettings(): Record<string, number> {
  const raw = readStorageJSON<Record<string, number>>(LOGGING_SAMPLING_STORAGE_KEY)
  if (!raw) {
    return {}
  }

  return Object.entries(raw).reduce<Record<string, number>>((acc, [module, rate]) => {
    if (
      typeof module === "string" &&
      module.trim().length > 0 &&
      typeof rate === "number" &&
      Number.isFinite(rate) &&
      rate >= 0 &&
      rate <= 1
    ) {
      acc[module] = rate
    }
    return acc
  }, {})
}

function applySamplingSettings(sampling: Record<string, number>): void {
  if (Object.keys(sampling).length === 0) {
    return
  }

  const normalized = Object.fromEntries(
    Object.entries(sampling).map(([module, rate]) => [module, { rate }])
  ) as Parameters<typeof configureSampling>[0]
  configureSampling(normalized)
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback
  }

  if (value < min || value > max) {
    return fallback
  }

  return value
}

function sanitizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback]
  }

  const sanitized = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0
  )
  return sanitized.length > 0 ? sanitized : [...fallback]
}

function sanitizeConfig(raw: Partial<UnifiedLoggerConfig> | null): Partial<UnifiedLoggerConfig> {
  if (!raw) {
    return {}
  }

  const sanitized: Partial<UnifiedLoggerConfig> = {}

  if (typeof raw.minLevel === "string" && VALID_LOG_LEVELS.has(raw.minLevel as LogLevel)) {
    sanitized.minLevel = raw.minLevel as LogLevel
  }

  if (typeof raw.includeStackTrace === "boolean") {
    sanitized.includeStackTrace = raw.includeStackTrace
  }

  if (typeof raw.includeSource === "boolean") {
    sanitized.includeSource = raw.includeSource
  }

  sanitized.bufferSize = clampNumber(raw.bufferSize, 1, 1000, DEFAULT_UNIFIED_CONFIG.bufferSize)
  sanitized.flushInterval = clampNumber(
    raw.flushInterval,
    250,
    60_000,
    DEFAULT_UNIFIED_CONFIG.flushInterval
  )
  sanitized.remoteQueueMaxEntries = clampNumber(
    raw.remoteQueueMaxEntries,
    100,
    100_000,
    DEFAULT_UNIFIED_CONFIG.remoteQueueMaxEntries
  )
  sanitized.remoteQueueMaxBytes = clampNumber(
    raw.remoteQueueMaxBytes,
    1024 * 1024,
    100 * 1024 * 1024,
    DEFAULT_UNIFIED_CONFIG.remoteQueueMaxBytes
  )
  sanitized.diagnosticRateLimitMs = clampNumber(
    raw.diagnosticRateLimitMs,
    250,
    60_000,
    DEFAULT_UNIFIED_CONFIG.diagnosticRateLimitMs
  )

  if (raw.redaction && typeof raw.redaction === "object") {
    sanitized.redaction = {
      enabled:
        typeof raw.redaction.enabled === "boolean"
          ? raw.redaction.enabled
          : DEFAULT_UNIFIED_CONFIG.redaction.enabled,
      replacement:
        typeof raw.redaction.replacement === "string" && raw.redaction.replacement.trim().length > 0
          ? raw.redaction.replacement
          : DEFAULT_UNIFIED_CONFIG.redaction.replacement,
      redactKeys: sanitizeStringArray(
        raw.redaction.redactKeys,
        DEFAULT_UNIFIED_CONFIG.redaction.redactKeys
      ),
      redactPatterns: sanitizeStringArray(
        raw.redaction.redactPatterns,
        DEFAULT_UNIFIED_CONFIG.redaction.redactPatterns
      ),
      maxDepth: clampNumber(
        raw.redaction.maxDepth,
        1,
        16,
        DEFAULT_UNIFIED_CONFIG.redaction.maxDepth
      ),
    }
  }

  return sanitized
}

function readConfigSettings(): Partial<UnifiedLoggerConfig> {
  const raw = readStorageJSON<UnifiedLoggerConfig>(LOGGING_CONFIG_STORAGE_KEY)
  return sanitizeConfig(raw)
}

function getPersistedConfig(config: UnifiedLoggerConfig): Partial<UnifiedLoggerConfig> {
  return {
    minLevel: config.minLevel,
    includeStackTrace: config.includeStackTrace,
    includeSource: config.includeSource,
    bufferSize: config.bufferSize,
    flushInterval: config.flushInterval,
    remoteQueueMaxEntries: config.remoteQueueMaxEntries,
    remoteQueueMaxBytes: config.remoteQueueMaxBytes,
    diagnosticRateLimitMs: config.diagnosticRateLimitMs,
    redaction: {
      enabled: config.redaction.enabled,
      replacement: config.redaction.replacement,
      redactKeys: [...config.redaction.redactKeys],
      redactPatterns: [...config.redaction.redactPatterns],
      maxDepth: config.redaction.maxDepth,
    },
  }
}

function persistSettings(
  config: UnifiedLoggerConfig,
  transports: LoggingTransportSettings,
  retention: LoggingRetentionSettings
): void {
  if (typeof window === "undefined") {
    return
  }
  localStorage.setItem(LOGGING_CONFIG_STORAGE_KEY, JSON.stringify(getPersistedConfig(config)))
  localStorage.setItem(LOGGING_TRANSPORTS_STORAGE_KEY, JSON.stringify(transports))
  localStorage.setItem(LOGGING_RETENTION_STORAGE_KEY, JSON.stringify(retention))
}

function applyTransportSettings(
  transports: LoggingTransportSettings,
  retention: LoggingRetentionSettings,
  config: UnifiedLoggerConfig
): void {
  if (transports.console) {
    addTransport(createConsoleTransport())
  } else {
    removeTransport("console")
  }

  if (transports.indexedDB) {
    const existing = getTransport<IndexedDBTransport>("indexeddb")
    if (existing && typeof existing.updateOptions === "function") {
      existing.updateOptions({
        maxEntries: retention.maxEntries,
        retentionDays: retention.maxAgeDays,
      })
      addTransport(existing)
    } else {
      removeTransport("indexeddb")
      addTransport(
        createIndexedDBTransport({
          maxEntries: retention.maxEntries,
          retentionDays: retention.maxAgeDays,
        })
      )
    }
  } else {
    removeTransport("indexeddb")
  }

  if (transports.native) {
    addTransport(
      createNativeTransport({
        minLevel: transports.nativeConfig.minLevel,
        batchSize: transports.nativeConfig.batchSize,
        flushInterval: transports.nativeConfig.flushInterval,
      })
    )
  } else {
    removeTransport("native")
  }
  void setPlatformLoggingConfig({
    enabled: transports.native,
    minLevel: transports.nativeConfig.minLevel,
  })

  if (transports.remote && config.remoteEndpoint) {
    addTransport(
      createRemoteTransport({
        endpoint: transports.remoteConfig.endpoint || config.remoteEndpoint,
        batchSize: transports.remoteConfig.batchSize,
        flushInterval: transports.remoteConfig.flushInterval,
        maxRetries: transports.remoteConfig.maxRetries,
        retryDelay: transports.remoteConfig.retryDelay,
        maxQueueEntries: config.remoteQueueMaxEntries,
        maxQueueBytes: config.remoteQueueMaxBytes,
        diagnosticRateLimitMs: config.diagnosticRateLimitMs,
        diagnosticEmitter: (event) => {
          emitLoggerDiagnostic({
            code: event.code,
            message: event.message,
            level: event.level,
            data: event.data,
            sourceTransport: event.sourceTransport || "remote",
            skipTransports: ["remote"],
          })
        },
      })
    )
  } else {
    removeTransport("remote")
  }

  if (transports.langfuse) {
    addTransport(
      createLangfuseTransport({
        publicKey: transports.langfuseConfig.publicKey || undefined,
        secretKey: transports.langfuseConfig.secretKey || undefined,
        host: transports.langfuseConfig.host || undefined,
        minLevel: transports.langfuseConfig.minLevel,
      })
    )
  } else {
    removeTransport("langfuse")
  }

  if (transports.opentelemetry) {
    addTransport(
      createOtelTransport({
        endpoint: transports.opentelemetryConfig.endpoint,
        serviceName: transports.opentelemetryConfig.serviceName,
        addAsSpanEvents: transports.opentelemetryConfig.addAsSpanEvents,
      })
    )
  } else {
    removeTransport("opentelemetry")
  }
}

export function bootstrapLogger(config?: Partial<UnifiedLoggerConfig>): LoggingBootstrapState {
  const persistedConfig = readConfigSettings()
  const transportSettings = readTransportSettings()
  const retentionSettings = readRetentionSettings()
  const samplingSettings = readSamplingSettings()
  const nextConfig: Partial<UnifiedLoggerConfig> = {
    ...persistedConfig,
    ...config,
    ...(persistedConfig.redaction || config?.redaction
      ? {
          redaction: {
            ...DEFAULT_UNIFIED_CONFIG.redaction,
            ...(persistedConfig.redaction || {}),
            ...(config?.redaction || {}),
          },
        }
      : {}),
  }

  if (!hasBootstrapped) {
    initLogger(nextConfig)
    hasBootstrapped = true
  } else if (config) {
    updateLoggerConfig(nextConfig)
  }

  const mergedConfig = getLoggerConfig()
  applyTransportSettings(transportSettings, retentionSettings, mergedConfig)
  applySamplingSettings(samplingSettings)

  currentState = {
    config: mergedConfig,
    transports: transportSettings,
    retention: retentionSettings,
  }

  return currentState
}

export function applyLoggingSettings(params: {
  config?: Partial<UnifiedLoggerConfig>
  transports?: Partial<LoggingTransportSettings>
  retention?: Partial<LoggingRetentionSettings>
  persist?: boolean
}): LoggingBootstrapState {
  if (!hasBootstrapped) {
    bootstrapLogger()
  }

  const existing = currentState || {
    config: getLoggerConfig(),
    transports: readTransportSettings(),
    retention: readRetentionSettings(),
  }

  const nextTransports = {
    ...existing.transports,
    ...(params.transports || {}),
  }
  const nextRetention = {
    ...existing.retention,
    ...(params.retention || {}),
  }

  if (params.config) {
    updateLoggerConfig(params.config)
  }

  const nextConfig = getLoggerConfig()
  applyTransportSettings(nextTransports, nextRetention, nextConfig)

  if (params.persist !== false) {
    persistSettings(nextConfig, nextTransports, nextRetention)
  }

  currentState = {
    config: nextConfig,
    transports: nextTransports,
    retention: nextRetention,
  }

  return currentState
}

export function getLoggingBootstrapState(): LoggingBootstrapState {
  if (!currentState) {
    return bootstrapLogger()
  }
  return currentState
}

export function getIndexedDBTransport(): IndexedDBTransport | undefined {
  return getTransport<IndexedDBTransport>("indexeddb")
}

export function listRegisteredTransports(): string[] {
  return getTransports().map((transport) => transport.name)
}
