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
  secretKey: string
  host: string
  minLevel: LogLevel
}

export interface OpenTelemetryTransportDetailSettings {
  endpoint: string
  serviceName: string
  addAsSpanEvents: boolean
}

export interface NativeTransportDetailSettings {
  minLevel: LogLevel
  batchSize: number
  flushInterval: number
}

export interface LoggingTransportSettings {
  console: boolean
  indexedDB: boolean
  native: boolean
  remote: boolean
  langfuse: boolean
  opentelemetry: boolean
  nativeConfig: NativeTransportDetailSettings
  remoteConfig: RemoteTransportDetailSettings
  langfuseConfig: LangfuseTransportDetailSettings
  opentelemetryConfig: OpenTelemetryTransportDetailSettings
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
