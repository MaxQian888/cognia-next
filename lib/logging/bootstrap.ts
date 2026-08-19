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
import {
  IndexedDBObservabilitySpoolStore,
  ObservabilitySpool,
  ObservabilitySpoolTransport,
  createObservabilitySpoolTransport,
  logContext,
} from "@cognia/logging"
import { DEFAULT_UNIFIED_CONFIG } from "@/types/logging"
import type {
  LogLevel,
  UnifiedLoggerConfig,
  RemoteTransportDetailSettings,
  LangfuseTransportDetailSettings,
  NativeTransportDetailSettings,
  AgentTraceTransportDetailSettings,
  AgentTraceOtlpSettings,
  PostHogTelemetrySettings,
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
import {
  configureBehaviorEventExporters,
  createOtlpBehaviorEventExporter,
  type BehaviorEventExporter,
} from "@/lib/telemetry/events/track-event"
import { buildPostHogProductExporters } from "@/lib/telemetry/posthog-product"
import {
  createObservabilityRuntimeScope,
  resolveObservabilityInstallationId,
  resolveObservabilityRuntime,
} from "./observability-runtime"

export type {
  RemoteTransportDetailSettings,
  LangfuseTransportDetailSettings,
  NativeTransportDetailSettings,
  AgentTraceTransportDetailSettings,
  AgentTraceOtlpSettings,
  PostHogTelemetrySettings,
  LoggingTransportSettings,
  LoggingRetentionSettings,
  LoggingBootstrapState,
} from "@/types/logging"

export const LOGGING_TRANSPORTS_STORAGE_KEY = "cognia-logging-transports"
export const LOGGING_RETENTION_STORAGE_KEY = "cognia-logging-retention"
export const LOGGING_CONFIG_STORAGE_KEY = "cognia-logging-config"
export const LOGGING_SAMPLING_STORAGE_KEY = "cognia-logging-sampling"
export const OBSERVABILITY_SPOOL_MAX_EVENTS = 50_000
export const OBSERVABILITY_SPOOL_MAX_BYTES = 250 * 1024 * 1024

// All 6 transports enabled by default per the Phase-6 product decision.
// Remote / Langfuse / OpenTelemetry short-circuit silently when their
// credentials/endpoints are blank — see `applyTransportSettings()` below
// which gates remote attachment on a non-empty endpoint, the Langfuse
// transport which sends direct ingestion batches and no-ops on missing keys, and the OTel
// transport which guards POST against unreachable endpoints. Their
// `enabled` flag stays true so the panel surfaces a `Degraded` health
// badge until the user fills in the config in Settings → Observability.
export const DEFAULT_TRANSPORT_SETTINGS: LoggingTransportSettings = {
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
  posthogConfig: {
    managed: { productAnalytics: false, aiObservability: false },
    byo: {
      productAnalytics: false,
      aiObservability: false,
      host: "",
      projectToken: "",
    },
  },
}

export const DEFAULT_RETENTION_SETTINGS: LoggingRetentionSettings = {
  maxEntries: 10_000,
  maxAgeDays: 7,
}

/**
 * Accepted range for each retention bound, exported so the settings panel's
 * sliders cannot offer a value this module would clamp away behind the user's
 * back.
 */
export const RETENTION_BOUNDS = {
  maxEntries: { min: 1_000, max: 100_000 },
  maxAgeDays: { min: 1, max: 30 },
} as const

/**
 * Accepted range for every numeric field of the unified config, shared between
 * `sanitizeConfig()` below and the settings panel's sliders. Duplicating them
 * had let the panel offer narrower ranges than the sanitizer accepts — a
 * ceiling of 20 000 queued entries against a real limit of 100 000, and 50 MB
 * against 100 MB — so a value set anywhere else silently snapped down the
 * first time the user touched the control.
 */
export const CONFIG_BOUNDS = {
  bufferSize: { min: 1, max: 1_000 },
  flushInterval: { min: 250, max: 60_000 },
  remoteQueueMaxEntries: { min: 100, max: 100_000 },
  remoteQueueMaxBytes: { min: 1024 * 1024, max: 100 * 1024 * 1024 },
  diagnosticRateLimitMs: { min: 250, max: 60_000 },
  redactionMaxDepth: { min: 1, max: 16 },
} as const

/**
 * A suggested sampling preset for the high-frequency modules — **not** a
 * default. `readSamplingSettings()` returns `{}` when nothing is stored and
 * `applySamplingSettings()` then configures nothing, so an unconfigured
 * install samples everything at 100%.
 *
 * It lives here rather than in the settings panel because the panel used to
 * own an identical list and *rendered it as the current state*: five rules
 * shown as active while the runtime had none. The panel now offers this as an
 * explicit "apply the recommended preset" action, which is the only thing that
 * ever writes it.
 */
export const RECOMMENDED_SAMPLING_RATES: Readonly<Record<string, number>> = Object.freeze({
  mouse: 0.01,
  keyboard: 0.1,
  scroll: 0.05,
  animation: 0.01,
  error: 1,
})

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
      posthogConfig: {
        managed: { ...DEFAULT_TRANSPORT_SETTINGS.posthogConfig.managed },
        byo: { ...DEFAULT_TRANSPORT_SETTINGS.posthogConfig.byo },
      },
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
  const posthogConfig = sanitizePostHogConfig(raw.posthogConfig)

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
    posthogConfig,
  }
}

function sanitizePostHogConfig(value: unknown): PostHogTelemetrySettings {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const managed =
    source.managed && typeof source.managed === "object" && !Array.isArray(source.managed)
      ? (source.managed as Record<string, unknown>)
      : {}
  const byo =
    source.byo && typeof source.byo === "object" && !Array.isArray(source.byo)
      ? (source.byo as Record<string, unknown>)
      : {}
  return {
    managed: {
      productAnalytics: managed.productAnalytics === true,
      aiObservability: managed.aiObservability === true,
    },
    byo: {
      productAnalytics: byo.productAnalytics === true,
      aiObservability: byo.aiObservability === true,
      host: typeof byo.host === "string" ? byo.host.trim() : "",
      projectToken: typeof byo.projectToken === "string" ? byo.projectToken.trim() : "",
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

/**
 * Retention was the one persisted record read without validation — a corrupted
 * or hand-edited value went straight into `IndexedDBTransport`'s cleanup pass,
 * where a negative or NaN bound silently disables pruning. Clamped to the same
 * range the settings panel offers.
 */
function readRetentionSettings(): LoggingRetentionSettings {
  const raw = readStorageJSON<LoggingRetentionSettings>(LOGGING_RETENTION_STORAGE_KEY) || {}
  return {
    maxEntries: clampNumber(
      raw.maxEntries,
      RETENTION_BOUNDS.maxEntries.min,
      RETENTION_BOUNDS.maxEntries.max,
      DEFAULT_RETENTION_SETTINGS.maxEntries
    ),
    maxAgeDays: clampNumber(
      raw.maxAgeDays,
      RETENTION_BOUNDS.maxAgeDays.min,
      RETENTION_BOUNDS.maxAgeDays.max,
      DEFAULT_RETENTION_SETTINGS.maxAgeDays
    ),
  }
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

  sanitized.bufferSize = clampNumber(
    raw.bufferSize,
    CONFIG_BOUNDS.bufferSize.min,
    CONFIG_BOUNDS.bufferSize.max,
    DEFAULT_UNIFIED_CONFIG.bufferSize
  )
  sanitized.flushInterval = clampNumber(
    raw.flushInterval,
    CONFIG_BOUNDS.flushInterval.min,
    CONFIG_BOUNDS.flushInterval.max,
    DEFAULT_UNIFIED_CONFIG.flushInterval
  )
  sanitized.remoteQueueMaxEntries = clampNumber(
    raw.remoteQueueMaxEntries,
    CONFIG_BOUNDS.remoteQueueMaxEntries.min,
    CONFIG_BOUNDS.remoteQueueMaxEntries.max,
    DEFAULT_UNIFIED_CONFIG.remoteQueueMaxEntries
  )
  sanitized.remoteQueueMaxBytes = clampNumber(
    raw.remoteQueueMaxBytes,
    CONFIG_BOUNDS.remoteQueueMaxBytes.min,
    CONFIG_BOUNDS.remoteQueueMaxBytes.max,
    DEFAULT_UNIFIED_CONFIG.remoteQueueMaxBytes
  )
  sanitized.diagnosticRateLimitMs = clampNumber(
    raw.diagnosticRateLimitMs,
    CONFIG_BOUNDS.diagnosticRateLimitMs.min,
    CONFIG_BOUNDS.diagnosticRateLimitMs.max,
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
        CONFIG_BOUNDS.redactionMaxDepth.min,
        CONFIG_BOUNDS.redactionMaxDepth.max,
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
  const runtime = resolveObservabilityRuntime({
    isTauri: isTauri(),
    platformHint: process.env.NEXT_PUBLIC_PLATFORM,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
  })
  const installationId = resolveObservabilityInstallationId(
    typeof localStorage === "undefined" ? undefined : localStorage
  )
  const posthogDestinations = resolvePostHogDestinations(transports.posthogConfig)

  if (transports.console) {
    addTransport(createConsoleTransport())
  } else {
    removeTransport("console")
  }

  if (transports.indexedDB) {
    // `bufferSize` / `flushInterval` are the write-batching knobs of this
    // transport, and the only consumer of those two config fields. They were
    // sanitized on read and persisted on save but never passed here, so both
    // silently ran at the transport's own defaults.
    const indexedDbOptions = {
      maxEntries: retention.maxEntries,
      retentionDays: retention.maxAgeDays,
      bufferSize: config.bufferSize,
      flushInterval: config.flushInterval,
    }
    const existing = getTransport<IndexedDBTransport>("indexeddb")
    if (existing && typeof existing.updateOptions === "function") {
      existing.updateOptions(indexedDbOptions)
      addTransport(existing)
    } else {
      removeTransport("indexeddb")
      addTransport(createIndexedDBTransport(indexedDbOptions))
    }
  } else {
    removeTransport("indexeddb")
  }

  const observabilitySpoolEnabled =
    transports.indexedDB && process.env.NEXT_PUBLIC_OBSERVABILITY_V1_SPOOL !== "0"
  if (observabilitySpoolEnabled) {
    const existing = getTransport<ObservabilitySpoolTransport>("observability-spool")
    if (existing) {
      addTransport(existing)
    } else {
      const spool = new ObservabilitySpool(new IndexedDBObservabilitySpoolStore(), {
        maxEvents: OBSERVABILITY_SPOOL_MAX_EVENTS,
        maxBytes: OBSERVABILITY_SPOOL_MAX_BYTES,
      })
      addTransport(
        createObservabilitySpoolTransport({
          spool,
          scope: () =>
            createObservabilityRuntimeScope({
              runtime,
              processId: logContext.sessionId,
              storage: typeof localStorage === "undefined" ? undefined : localStorage,
            }),
          onDiagnostic: (event) => {
            emitLoggerDiagnostic({
              code: event.code,
              message: event.message,
              level: event.level,
              data: event.data,
              sourceTransport: event.sourceTransport || "observability-spool",
              skipTransports: ["observability-spool"],
            })
          },
        })
      )
    }
  } else {
    removeTransport("observability-spool")
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
        exportBatch:
          isTauri() && transports.langfuseConfig.secretKeyConfigured === true
            ? async (batch) => {
                await postTauriTelemetryJson(
                  `${langfuseHost}/api/public/ingestion`,
                  JSON.stringify(batch),
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
      // Remote OTLP is metadata-only even when local agent-trace previews are enabled.
      captureContent: false,
      maxPreviewBytes: 0,
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
  } else {
    removeTransport("agent-trace-otlp")
  }

  for (const destination of posthogDestinations.filter((item) => item.aiObservability)) {
    const transportName = `agent-trace-posthog-${destination.id}`
    const existing = getTransport<OtlpHttpTransport>(transportName)
    const fetchImpl = isTauri()
      ? createTauriOtlpFetch({
          credential: { kind: "posthog", projectToken: destination.projectToken },
        })
      : createWebPostHogFetch(destination.projectToken)
    const options = {
      transportName,
      endpoint: postHogAiEndpoint(destination.host),
      resource: {
        serviceName: "cognia-ai",
        environment: transports.agentTraceOtlpConfig.environment || undefined,
        // PostHog resolves the person of an `$ai_generation` from this span
        // attribute. Without it the renderer's half of a turn lands on a
        // different (anonymous) person than the sidecar's half, which already
        // stamps the same id through `enrichSpan`.
        spanAttributes: { "posthog.distinct_id": installationId },
      },
      captureContent: false,
      maxPreviewBytes: 0,
      fetchImpl,
    } as const
    if (existing) {
      existing.updateOptions(options)
      addTransport(existing)
    } else {
      addTransport(createOtlpHttpTransport(options))
    }
  }
  for (const id of ["managed", "byo"] as const) {
    if (!posthogDestinations.some((item) => item.id === id && item.aiObservability)) {
      const transportName = `agent-trace-posthog-${id}`
      getTransport<OtlpHttpTransport>(transportName)?.discardPending()
      removeTransport(transportName)
    }
  }

  const hasPostHogAi = posthogDestinations.some((item) => item.aiObservability)
  setAgentTraceWriter(
    transports.agentTrace || transports.agentTraceOtlp || hasPostHogAi
      ? dispatchSpanToTransports
      : null
  )
  if (isTauri()) {
    void configureTauriSidecarTelemetry({
      enabled: transports.agentTraceOtlp,
      endpoint: transports.agentTraceOtlp
        ? transports.agentTraceOtlpConfig.endpoint
        : "http://localhost",
      headers: transports.agentTraceOtlp ? { ...transports.agentTraceOtlpConfig.headers } : {},
      serviceName: "cognia-sidecar",
      environment: transports.agentTraceOtlp ? transports.agentTraceOtlpConfig.environment : "",
      credential:
        transports.agentTraceOtlp && transports.agentTraceOtlpConfig.preset === "grafana-cloud"
          ? {
              kind: "grafanaCloud",
              instanceId: transports.agentTraceOtlpConfig.grafanaCloud.instanceId,
            }
          : { kind: "none" },
      posthogDestinations: posthogDestinations
        .filter((item) => item.aiObservability)
        .map(({ id, host, projectToken }) => ({ id, host, projectToken })),
      installationId,
    }).catch(() => {})
  }

  // Behavior telemetry has its own opt-in and remains independent of the
  // engineering trace transport toggle. It may reuse the configured OTLP
  // destination, but disabling traces must not disable behavior export.
  const behaviorExporters: BehaviorEventExporter[] = []
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
    behaviorExporters.push(
      createOtlpBehaviorEventExporter(async (body) => {
        const response = await behaviorFetch(behaviorEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...behaviorHeaders },
          body,
        })
        if (!response.ok) throw new Error(`OTLP logs export failed with ${response.status}`)
      })
    )
  }
  const managed = posthogDestinations.find((item) => item.id === "managed")
  const byo = posthogDestinations.find((item) => item.id === "byo")
  behaviorExporters.push(
    ...buildPostHogProductExporters({
      installationId,
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION || "0.1.0",
      runtime,
      // The desktop CSP (`connect-src` in tauri.conf.json) does not allow the
      // renderer to reach PostHog directly, so the capture batch goes out over
      // the same Rust leg as every other outbound request.
      postJson: isTauri()
        ? (url, body) => postTauriTelemetryJson(url, body, { kind: "none" })
        : undefined,
      managed: {
        enabled: managed?.productAnalytics === true,
        host: managed?.host ?? "",
        projectToken: managed?.projectToken ?? "",
      },
      byo: {
        enabled: byo?.productAnalytics === true,
        host: byo?.host ?? "",
        projectToken: byo?.projectToken ?? "",
      },
    })
  )
  configureBehaviorEventExporters(behaviorExporters)
}

interface ResolvedPostHogDestination {
  id: "managed" | "byo"
  host: string
  projectToken: string
  productAnalytics: boolean
  aiObservability: boolean
}

export function resolvePostHogDestinations(
  config: PostHogTelemetrySettings
): ResolvedPostHogDestination[] {
  const destinations: ResolvedPostHogDestination[] = []
  const managedHost = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() ?? ""
  const managedToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim() ?? ""
  const normalizedManagedHost = normalizeHttpOrigin(managedHost)
  if (normalizedManagedHost && managedToken.startsWith("phc_")) {
    destinations.push({
      id: "managed",
      host: normalizedManagedHost,
      projectToken: managedToken,
      ...config.managed,
    })
  }
  const byoHost = config.byo.host.trim()
  const byoToken = config.byo.projectToken.trim()
  const normalizedByoHost = normalizeHttpOrigin(byoHost)
  if (normalizedByoHost && byoToken.startsWith("phc_")) {
    destinations.push({
      id: "byo",
      host: normalizedByoHost,
      projectToken: byoToken,
      productAnalytics: config.byo.productAnalytics,
      aiObservability: config.byo.aiObservability,
    })
  }
  return destinations
}

function normalizeHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null
  } catch {
    return null
  }
}

export function postHogAiEndpoint(host: string): string {
  return `${new URL(host).origin}/i/v0/ai/otel`
}

function createWebPostHogFetch(projectToken: string): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${projectToken}`)
    return globalThis.fetch(input, { ...init, headers })
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

  // The core keeps its own copy of four settings that the transport/retention
  // records also express, and `syncBuiltinTransports()` acts on one of them
  // (`enableConsole`) on *every* `ensureInitialized()` — which every registry
  // call runs. Leaving them unsynced meant turning "Console Output" off did
  // nothing durable: `applyTransportSettings` removed the console transport,
  // and the next `addTransport` for another sink put it straight back. Derive
  // all four from the records that own them so the two views cannot disagree.
  // (`logger-provider.tsx` already sent both halves for exactly this reason.)
  updateLoggerConfig({
    ...(params.config || {}),
    enableConsole: nextTransports.console,
    enableStorage: nextTransports.indexedDB,
    enableRemote: nextTransports.remote,
    maxStorageEntries: nextRetention.maxEntries,
  })

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

export function getObservabilitySpoolTransport(): ObservabilitySpoolTransport | undefined {
  return getTransport<ObservabilitySpoolTransport>("observability-spool")
}

export function listRegisteredTransports(): string[] {
  return getTransports().map((transport) => transport.name)
}
