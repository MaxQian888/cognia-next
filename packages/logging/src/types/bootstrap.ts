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

export interface LangfuseTransportDetailSettings {
  publicKey: string
  /** Write-only secret lives in the platform secret store. */
  secretKeyConfigured: boolean
  host: string
  minLevel: LogLevel
}

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
  /** Headers map sent on every batch. Auth token typically lives here. */
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
  nativeConfig: NativeTransportDetailSettings
  remoteConfig: RemoteTransportDetailSettings
  langfuseConfig: LangfuseTransportDetailSettings
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
