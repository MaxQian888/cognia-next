/**
 * Bootstrap / Settings Types
 */

import type { LogLevel } from "./log-level"
import type { UnifiedLoggerConfig } from "./logger"

export interface RemoteTransportDetailSettings {
  endpoint: string
  batchSize: number
  flushInterval: number
  maxRetries: number
  retryDelay: number
}

export interface LangfuseTraceSettings {
  enabled: boolean
  /** Langfuse project host; the exporter pins the path to OTLP traces. */
  baseUrl: string
  publicKey: string
  /** Write-only secret lives in the platform secret store. */
  secretKeyConfigured: boolean
  environment: string
  /** Consent to export model and root-observation previews. */
  captureModelContent: boolean
  /** Independent consent to export tool argument/result previews. */
  captureToolContent: boolean
}

/** @deprecated Use LangfuseTraceSettings. */
export type LangfuseTransportDetailSettings = LangfuseTraceSettings

export interface NativeTransportDetailSettings {
  minLevel: LogLevel
  batchSize: number
  flushInterval: number
}

export interface AgentTraceTransportDetailSettings {
  /**
   * Persist `inputPreview` / `outputPreview` payloads on spans. Off by
   * default — when on, the transport runs each preview through
   * `packages/redact/src/index.ts:hasNoLeakingPii` and drops fields that leak
   * PII before they hit Dexie.
   */
  captureContent: boolean
  /** Per-field byte cap when content capture is on. */
  maxPreviewBytes: number
  /** Days of retention before the periodic prune drops a span. */
  retentionDays: number
}

/**
 * OTLP/HTTP exporter — pushes finished agent-trace spans to an external
 * OTel-compatible backend (Grafana Cloud / Tempo / Honeycomb / Datadog
 * OTLP / a self-hosted OTel Collector). When enabled with a non-empty
 * endpoint, spans dispatched through the agent-trace writer are also
 * POSTed there in JSON form.
 */
export interface OtlpExporterPreset {
  kind: "off" | "grafana-cloud" | "self-hosted" | "custom"
}

export interface AgentTraceOtlpSettings {
  /** Preset shape used to pre-fill / validate the endpoint + headers. */
  preset: OtlpExporterPreset["kind"]
  /** Full URL of the OTLP traces endpoint. Empty disables. */
  endpoint: string
  /**
   * INERT. Always `{}` — nothing here ever reaches the wire.
   *
   * Renderer-held headers cannot be proven credential-free, so authentication
   * moved to the Rust Host (desktop) or the Collector (web/mobile):
   * `sanitizeOtlpHeaders()` in `lib/logging/bootstrap.ts` discards whatever is
   * written here, `applyTransportSettings` sends `headers: {}`, and the settings
   * panel no longer renders a field for it (pinned by
   * `components/settings/logs/panels/transports-panel.test.tsx`).
   *
   * Kept on the type so a persisted legacy value still parses and is dropped on
   * the next save rather than crashing the read. Do NOT wire an auth token
   * through it — it will be silently discarded.
   */
  headers: Record<string, string>
  /** Resource attribute `service.name`. */
  serviceName: string
  /** Optional `deployment.environment.name`. */
  environment: string
  /**
   * Grafana Cloud preset credentials. Stored separately from `headers` so
   * the user doesn't have to base64-encode them by hand — `bootstrap.ts`
   * computes the `Authorization: Basic ...` header at apply time when
   * `preset === "grafana-cloud"`. Empty values short-circuit (no header).
   */
  grafanaCloud: {
    instanceId: string
    /** Write-only token lives in the platform secret store. */
    apiTokenConfigured: boolean
  }
}

export interface PostHogTelemetryScopeSettings {
  productAnalytics: boolean
  aiObservability: boolean
}

export interface PostHogTelemetrySettings {
  managed: PostHogTelemetryScopeSettings
  byo: PostHogTelemetryScopeSettings & {
    /** PostHog ingestion host, for example https://us.i.posthog.com. */
    host: string
    /** Public project ingestion token. Personal API keys are never accepted. */
    projectToken: string
  }
}

export interface LoggingTransportSettings {
  console: boolean
  indexedDB: boolean
  native: boolean
  remote: boolean
  langfuse: boolean
  agentTrace: boolean
  agentTraceOtlp: boolean
  /** Export ordinary redacted StructuredLogEntry records through OTLP Logs. */
  otlpLogs: boolean
  nativeConfig: NativeTransportDetailSettings
  remoteConfig: RemoteTransportDetailSettings
  langfuseConfig: LangfuseTraceSettings
  agentTraceConfig: AgentTraceTransportDetailSettings
  agentTraceOtlpConfig: AgentTraceOtlpSettings
  posthogConfig: PostHogTelemetrySettings
}

export interface LoggingRetentionSettings {
  maxEntries: number
  maxAgeDays: number
}

export interface LoggingBootstrapState {
  config: UnifiedLoggerConfig
  transports: LoggingTransportSettings
  retention: LoggingRetentionSettings
}
