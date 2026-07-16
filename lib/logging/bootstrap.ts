import {
  addTransport,
  emitLoggerDiagnostic,
  getLoggerConfig,
  getTransport,
  getTransports,
  initLogger,
  removeTransport,
  updateLoggerConfig,
} from "@cognia/logging/core"
import { DEFAULT_UNIFIED_CONFIG } from "@/types/logging"
import type {
  LogLevel,
  UnifiedLoggerConfig,
  RemoteTransportDetailSettings,
  LangfuseTransportDetailSettings,
  NativeTransportDetailSettings,
  AgentTraceTransportDetailSettings,
  AgentTraceOtlpSettings,
  LoggingTransportSettings,
  LoggingRetentionSettings,
  LoggingBootstrapState,
} from "@/types/logging"
import { configureSampling } from "@cognia/logging/sampling"
import {
  AgentTraceTransport,
  createAgentTraceTransport,
  createBreadcrumbTransport,
  createConsoleTransport,
  createIndexedDBTransport,
  createLangfuseTransport,
  createNativeTransport,
  createOtlpHttpTransport,
  createRemoteTransport,
  IndexedDBTransport,
  OtlpHttpTransport,
} from "./transports"
import { setPlatformLoggingConfig } from "@/lib/native/native-logging"
import { setAgentTraceWriter } from "@cognia/agent-trace/emitter"
import { spanToLogEntry } from "@cognia/agent-trace/span-to-log-entry"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { isTauri } from "@/lib/platform/detect"
import {
  configureTauriSidecarTelemetry,
  createTauriOtlpFetch,
  postTauriTelemetryJson,
} from "./transports/tauri-fetch-shim"
import {
  extractLegacyTelemetrySecrets,
  getTelemetrySecretForWeb,
  persistLegacyTelemetrySecrets,
} from "./telemetry-secrets"
import { configureBehaviorEventExporter } from "@/lib/telemetry/events/track-event"

export type {
  RemoteTransportDetailSettings,
  LangfuseTransportDetailSettings,
  NativeTransportDetailSettings,
  AgentTraceTransportDetailSettings,
  AgentTraceOtlpSettings,
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
  agentTrace: true,
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
    secretKeyConfigured: false,
    host: "https://cloud.langfuse.com",
    minLevel: "warn",
  },
  agentTraceOtlp: false,
  agentTraceConfig: {
    captureContent: false,
    maxPreviewBytes: 4096,
    retentionDays: 7,
  },
  agentTraceOtlpConfig: {
    preset: "off",
    endpoint: "",
    headers: {},
    serviceName: "cognia-ai",
    environment: "",
    grafanaCloud: { instanceId: "", apiTokenConfigured: false },
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
  let raw = readStorageJSON<LoggingTransportSettings>(LOGGING_TRANSPORTS_STORAGE_KEY)
  if (!raw) {
    return {
      ...DEFAULT_TRANSPORT_SETTINGS,
      nativeConfig: { ...DEFAULT_TRANSPORT_SETTINGS.nativeConfig },
      remoteConfig: { ...DEFAULT_TRANSPORT_SETTINGS.remoteConfig },
      langfuseConfig: { ...DEFAULT_TRANSPORT_SETTINGS.langfuseConfig },
      agentTraceConfig: { ...DEFAULT_TRANSPORT_SETTINGS.agentTraceConfig },
      agentTraceOtlpConfig: { ...DEFAULT_TRANSPORT_SETTINGS.agentTraceOtlpConfig },
    }
  }

  const migration = extractLegacyTelemetrySecrets(raw)
  if (Object.keys(migration.secrets).length > 0) {
    raw = migration.settings as Partial<LoggingTransportSettings>
    void persistLegacyTelemetrySecrets(migration.secrets)
      .then(() => {
        // Erase plaintext only after every keyring write succeeds. A failed
        // migration must leave the source intact so the next boot can retry.
        localStorage.setItem(LOGGING_TRANSPORTS_STORAGE_KEY, JSON.stringify(migration.settings))
      })
      .catch(() => {})
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
  const agentTraceConfig: Partial<AgentTraceTransportDetailSettings> =
    raw.agentTraceConfig && typeof raw.agentTraceConfig === "object"
      ? (raw.agentTraceConfig as Partial<AgentTraceTransportDetailSettings>)
      : {}
  const agentTraceOtlpConfig: Partial<AgentTraceOtlpSettings> =
    raw.agentTraceOtlpConfig && typeof raw.agentTraceOtlpConfig === "object"
      ? (raw.agentTraceOtlpConfig as Partial<AgentTraceOtlpSettings>)
      : {}

  return {
    console: typeof raw.console === "boolean" ? raw.console : DEFAULT_TRANSPORT_SETTINGS.console,
    indexedDB:
      typeof raw.indexedDB === "boolean" ? raw.indexedDB : DEFAULT_TRANSPORT_SETTINGS.indexedDB,
    native: typeof raw.native === "boolean" ? raw.native : DEFAULT_TRANSPORT_SETTINGS.native,
    remote: typeof raw.remote === "boolean" ? raw.remote : DEFAULT_TRANSPORT_SETTINGS.remote,
    langfuse:
      typeof raw.langfuse === "boolean" ? raw.langfuse : DEFAULT_TRANSPORT_SETTINGS.langfuse,
    agentTrace:
      typeof raw.agentTrace === "boolean" ? raw.agentTrace : DEFAULT_TRANSPORT_SETTINGS.agentTrace,
    agentTraceOtlp:
      typeof raw.agentTraceOtlp === "boolean"
        ? raw.agentTraceOtlp
        : DEFAULT_TRANSPORT_SETTINGS.agentTraceOtlp,
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
      secretKeyConfigured:
        typeof langfuseConfig.secretKeyConfigured === "boolean"
          ? langfuseConfig.secretKeyConfigured
          : false,
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
    agentTraceConfig: {
      captureContent:
        typeof agentTraceConfig.captureContent === "boolean"
          ? agentTraceConfig.captureContent
          : DEFAULT_TRANSPORT_SETTINGS.agentTraceConfig.captureContent,
      maxPreviewBytes: clampNumber(
        agentTraceConfig.maxPreviewBytes,
        256,
        65_536,
        DEFAULT_TRANSPORT_SETTINGS.agentTraceConfig.maxPreviewBytes
      ),
      retentionDays: clampNumber(
        agentTraceConfig.retentionDays,
        0,
        365,
        DEFAULT_TRANSPORT_SETTINGS.agentTraceConfig.retentionDays
      ),
    },
    agentTraceOtlpConfig: {
      preset: isValidOtlpPreset(agentTraceOtlpConfig.preset)
        ? agentTraceOtlpConfig.preset
        : DEFAULT_TRANSPORT_SETTINGS.agentTraceOtlpConfig.preset,
      endpoint:
        typeof agentTraceOtlpConfig.endpoint === "string"
          ? agentTraceOtlpConfig.endpoint
          : DEFAULT_TRANSPORT_SETTINGS.agentTraceOtlpConfig.endpoint,
      headers: sanitizeOtlpHeaders(agentTraceOtlpConfig.headers),
      serviceName:
        typeof agentTraceOtlpConfig.serviceName === "string" &&
        agentTraceOtlpConfig.serviceName.trim().length > 0
          ? agentTraceOtlpConfig.serviceName
          : DEFAULT_TRANSPORT_SETTINGS.agentTraceOtlpConfig.serviceName,
      environment:
        typeof agentTraceOtlpConfig.environment === "string"
          ? agentTraceOtlpConfig.environment
          : DEFAULT_TRANSPORT_SETTINGS.agentTraceOtlpConfig.environment,
      grafanaCloud: sanitizeGrafanaCloud(agentTraceOtlpConfig.grafanaCloud),
    },
  }
}

function sanitizeGrafanaCloud(value: unknown): AgentTraceOtlpSettings["grafanaCloud"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_TRANSPORT_SETTINGS.agentTraceOtlpConfig.grafanaCloud }
  }
  const v = value as Record<string, unknown>
  return {
    instanceId: typeof v.instanceId === "string" ? v.instanceId : "",
    apiTokenConfigured: typeof v.apiTokenConfigured === "boolean" ? v.apiTokenConfigured : false,
  }
}

const VALID_OTLP_PRESETS: ReadonlySet<AgentTraceOtlpSettings["preset"]> = new Set([
  "off",
  "grafana-cloud",
  "self-hosted",
  "custom",
])

function isValidOtlpPreset(value: unknown): value is AgentTraceOtlpSettings["preset"] {
  return (
    typeof value === "string" && VALID_OTLP_PRESETS.has(value as AgentTraceOtlpSettings["preset"])
  )
}

function sanitizeOtlpHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = k.trim().toLowerCase()
    if (
      normalized.length > 0 &&
      !["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"].includes(
        normalized
      ) &&
      typeof v === "string"
    ) {
      out[k] = v
    }
  }
  return out
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

function sanitizePerModuleLevels(value: unknown): Record<string, LogLevel> {
  if (!value || typeof value !== "object") {
    return {}
  }
  const sanitized: Record<string, LogLevel> = {}
  for (const [prefix, level] of Object.entries(value as Record<string, unknown>)) {
    if (
      prefix.trim().length > 0 &&
      typeof level === "string" &&
      VALID_LOG_LEVELS.has(level as LogLevel)
    ) {
      sanitized[prefix] = level as LogLevel
    }
  }
  return sanitized
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

  if (raw.perModuleLevels !== undefined) {
    sanitized.perModuleLevels = sanitizePerModuleLevels(raw.perModuleLevels)
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
    perModuleLevels: { ...(config.perModuleLevels ?? {}) },
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

  // Breadcrumb transport rides the native toggle: it only has anything to do
  // on desktop (it forwards to the Rust crash-context ring), and it's the
  // first real consumer of `pushCrashBreadcrumb`. No separate setting — when
  // native logging is on we also want crash breadcrumbs.
  if (transports.native) {
    addTransport(createBreadcrumbTransport())
  } else {
    removeTransport("breadcrumb")
  }

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
    const langfuseHost = (transports.langfuseConfig.host || "https://cloud.langfuse.com").replace(
      /\/$/,
      ""
    )
    addTransport(
      createLangfuseTransport({
        publicKey: transports.langfuseConfig.publicKey || undefined,
        resolveSecretKey: () => getTelemetrySecretForWeb("langfuseSecretKey"),
        nativeExport: isTauri()
          ? async (entries) => {
              const timestamp = new Date().toISOString()
              const batch = entries.flatMap((entry) => {
                const traceId = entry.traceId || entry.sessionId || crypto.randomUUID()
                const eventId = crypto.randomUUID()
                return [
                  {
                    id: crypto.randomUUID(),
                    timestamp,
                    type: "trace-create",
                    body: {
                      id: traceId,
                      timestamp,
                      name: "cognia.logger",
                      sessionId: entry.sessionId,
                      metadata: { source: "logger" },
                      tags: ["log"],
                    },
                  },
                  {
                    id: eventId,
                    timestamp,
                    type: "event-create",
                    body: {
                      id: eventId,
                      traceId,
                      timestamp,
                      name: `log.${entry.level}.${entry.module}`,
                      input: entry.message,
                      metadata: entry.data,
                      level:
                        entry.level === "error" || entry.level === "fatal"
                          ? "ERROR"
                          : entry.level === "warn"
                            ? "WARNING"
                            : entry.level === "trace" || entry.level === "debug"
                              ? "DEBUG"
                              : "DEFAULT",
                    },
                  },
                ]
              })
              await postTauriTelemetryJson(
                `${langfuseHost}/api/public/ingestion`,
                JSON.stringify({ batch }),
                { kind: "langfuse", publicKey: transports.langfuseConfig.publicKey }
              )
            }
          : undefined,
        host: transports.langfuseConfig.host || undefined,
        minLevel: transports.langfuseConfig.minLevel,
      })
    )
  } else {
    removeTransport("langfuse")
  }

  if (transports.agentTrace) {
    const existing = getTransport<AgentTraceTransport>("agent-trace")
    if (existing && typeof existing.updateOptions === "function") {
      existing.updateOptions({
        captureContent: transports.agentTraceConfig.captureContent,
        maxPreviewBytes: transports.agentTraceConfig.maxPreviewBytes,
        retentionDays: transports.agentTraceConfig.retentionDays,
      })
      addTransport(existing)
    } else {
      removeTransport("agent-trace")
      addTransport(
        createAgentTraceTransport({
          captureContent: transports.agentTraceConfig.captureContent,
          maxPreviewBytes: transports.agentTraceConfig.maxPreviewBytes,
          retentionDays: transports.agentTraceConfig.retentionDays,
        })
      )
    }
    setAgentTraceWriter(dispatchSpanToTransports)
  } else {
    removeTransport("agent-trace")
    setAgentTraceWriter(transports.agentTraceOtlp ? dispatchSpanToTransports : null)
  }

  // OTLP exporter — independent toggle from the Dexie sink so users can run
  // either alone or both together (Dexie powers the in-app UI, OTLP feeds
  // Grafana / Tempo / Honeycomb / Datadog). Empty endpoint short-circuits
  // to a `degraded` health status inside the transport itself.
  if (transports.agentTraceOtlp) {
    const otlpExisting = getTransport<OtlpHttpTransport>("agent-trace-otlp")
    const otlpHeaders = { ...transports.agentTraceOtlpConfig.headers }
    const grafanaCredential = {
      kind: "grafanaCloud" as const,
      instanceId: transports.agentTraceOtlpConfig.grafanaCloud.instanceId,
    }
    const fetchImpl = isTauri()
      ? createTauriOtlpFetch({
          credential:
            transports.agentTraceOtlpConfig.preset === "grafana-cloud"
              ? grafanaCredential
              : { kind: "none" },
        })
      : transports.agentTraceOtlpConfig.preset === "grafana-cloud"
        ? createWebGrafanaFetch(transports.agentTraceOtlpConfig.grafanaCloud.instanceId)
        : globalThis.fetch.bind(globalThis)
    const otlpOptions = {
      endpoint: transports.agentTraceOtlpConfig.endpoint,
      headers: otlpHeaders,
      resource: {
        serviceName: transports.agentTraceOtlpConfig.serviceName,
        environment: transports.agentTraceOtlpConfig.environment || undefined,
      },
      captureContent: transports.agentTraceConfig.captureContent,
      maxPreviewBytes: transports.agentTraceConfig.maxPreviewBytes,
      fetchImpl,
    } as const
    if (otlpExisting && typeof otlpExisting.updateOptions === "function") {
      otlpExisting.updateOptions(otlpOptions)
      addTransport(otlpExisting)
    } else {
      removeTransport("agent-trace-otlp")
      addTransport(createOtlpHttpTransport(otlpOptions))
    }
    // Make sure the emitter writer is wired even when the Dexie sink is off
    // — otherwise spans never reach any transport.
    setAgentTraceWriter(dispatchSpanToTransports)
    if (isTauri()) {
      void configureTauriSidecarTelemetry({
        enabled: true,
        endpoint: transports.agentTraceOtlpConfig.endpoint,
        headers: otlpHeaders,
        serviceName: "cognia-sidecar",
        environment: transports.agentTraceOtlpConfig.environment,
        credential:
          transports.agentTraceOtlpConfig.preset === "grafana-cloud"
            ? grafanaCredential
            : { kind: "none" },
      }).catch(() => {})
    }
  } else {
    removeTransport("agent-trace-otlp")
    if (isTauri()) {
      void configureTauriSidecarTelemetry({
        enabled: false,
        endpoint: "http://localhost",
        headers: {},
        serviceName: "cognia-sidecar",
        environment: "",
        credential: { kind: "none" },
      }).catch(() => {})
    }
  }

  // Behavior telemetry has its own opt-in and remains independent of the
  // engineering trace transport toggle. It may reuse the configured OTLP
  // destination, but disabling traces must not disable behavior export.
  const behaviorEndpoint = otlpLogsEndpoint(transports.agentTraceOtlpConfig.endpoint)
  if (behaviorEndpoint) {
    const behaviorHeaders = { ...transports.agentTraceOtlpConfig.headers }
    const behaviorFetch = isTauri()
      ? createTauriOtlpFetch({
          credential:
            transports.agentTraceOtlpConfig.preset === "grafana-cloud"
              ? {
                  kind: "grafanaCloud",
                  instanceId: transports.agentTraceOtlpConfig.grafanaCloud.instanceId,
                }
              : { kind: "none" },
        })
      : transports.agentTraceOtlpConfig.preset === "grafana-cloud"
        ? createWebGrafanaFetch(transports.agentTraceOtlpConfig.grafanaCloud.instanceId)
        : globalThis.fetch.bind(globalThis)
    configureBehaviorEventExporter(async (body) => {
      const response = await behaviorFetch(behaviorEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...behaviorHeaders },
        body,
      })
      if (!response.ok) throw new Error(`OTLP logs export failed with ${response.status}`)
    })
  } else {
    configureBehaviorEventExporter(null)
  }
}

export function otlpLogsEndpoint(tracesEndpoint: string): string {
  const trimmed = tracesEndpoint.trim()
  if (!trimmed) return ""
  if (/\/v1\/traces\/?$/.test(trimmed)) {
    return trimmed.replace(/\/v1\/traces\/?$/, "/v1/logs")
  }
  return `${trimmed.replace(/\/$/, "")}/v1/logs`
}

function createWebGrafanaFetch(instanceId: string): typeof fetch {
  return async (input, init) => {
    const token = await getTelemetrySecretForWeb("grafanaCloudApiToken")
    if (!token) throw new Error("Grafana Cloud API token is not configured")
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Basic ${globalThis.btoa(`${instanceId}:${token}`)}`)
    return globalThis.fetch(input, { ...init, headers })
  }
}

/** Emit a finished span as a synthetic `StructuredLogEntry` to every
 * registered transport. The trace transport recognises `data.kind ===
 * "agent-trace-span"` and persists the embedded span row; other transports
 * see it as a normal `module="agent.trace"` log line (the panel already has
 * a filter preset for that module). Failures are swallowed so an unwired
 * transport can't break an instrumented call site. */
function dispatchSpanToTransports(span: AgentTraceSpan): void {
  const entry = spanToLogEntry(span)
  for (const t of getTransports()) {
    try {
      void t.log(entry)
    } catch {
      // Transports report their own diagnostics; the emitter contract
      // forbids throwing back into instrumented code.
    }
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
