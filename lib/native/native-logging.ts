import { invoke } from "@tauri-apps/api/core"
import { isTauri, transport } from "@/lib/tauri"
import {
  getNativeLoggingReadiness as getNativeLoggingReadinessState,
  updateNativeLoggingReadiness,
  type NativeLoggingReadiness,
  type NativeLoggingFallbackReason,
  type PlatformLoggingLevel,
  type PlatformLoggingStatus,
  type NativeLoggingStartupHealth,
  type NativeLoggingStartupMode,
} from "./native-logging-readiness"

interface NativeLoggingReadinessPayload {
  startupMode?: NativeLoggingStartupMode
  startupHealth?: NativeLoggingStartupHealth
  activeTargets?: string[]
  fallbackReason?: NativeLoggingFallbackReason
  platformLogging?: PlatformLoggingStatus
  checkedAt?: string
}

export interface PlatformLoggingConfigUpdate {
  enabled?: boolean
  minLevel?: PlatformLoggingLevel
}

export interface PlatformLogEntryPayload {
  level: PlatformLoggingLevel
  module: string
  message: string
  timestamp?: string
  traceId?: string
  sessionId?: string
  data?: Record<string, unknown>
}

export async function getNativeLoggingReadiness(): Promise<NativeLoggingReadiness | null> {
  if (!isTauri()) {
    return null
  }

  try {
    const payload = await invoke<NativeLoggingReadinessPayload>("native_logging_get_readiness")
    return updateNativeLoggingReadiness({
      runtime: "tauri",
      startupMode: payload.startupMode ?? "unknown",
      startupHealth: payload.startupHealth ?? "inactive",
      activeTargets: payload.activeTargets ?? [],
      platformLogging: payload.platformLogging,
      fallbackReason: payload.fallbackReason ?? null,
      checkedAt: payload.checkedAt,
    })
  } catch (error) {
    return updateNativeLoggingReadiness({
      runtime: "tauri",
      startupMode: "fallback",
      startupHealth: "degraded",
      fallbackReason: {
        code: "native_readiness_query_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

export function getNativeLoggingReadinessSnapshot(): NativeLoggingReadiness {
  return getNativeLoggingReadinessState()
}

export async function getPlatformLoggingStatus(): Promise<PlatformLoggingStatus | null> {
  if (!isTauri()) {
    return null
  }

  try {
    const status = await invoke<PlatformLoggingStatus>("platform_logging_get_status")
    updateNativeLoggingReadiness({
      runtime: "tauri",
      platformLogging: status,
    })
    return status
  } catch {
    return getNativeLoggingReadinessState().platformLogging
  }
}

export async function setPlatformLoggingConfig(
  config: PlatformLoggingConfigUpdate
): Promise<PlatformLoggingStatus | null> {
  if (!isTauri()) {
    return null
  }

  try {
    const status = await invoke<PlatformLoggingStatus>("platform_logging_set_config", {
      config,
    })
    updateNativeLoggingReadiness({
      runtime: "tauri",
      platformLogging: status,
    })
    return status
  } catch (error) {
    updateNativeLoggingReadiness({
      runtime: "tauri",
      platformLogging: {
        ...getNativeLoggingReadinessState().platformLogging,
        health: "degraded",
        error: error instanceof Error ? error.message : String(error),
      },
    })
    return null
  }
}

export async function forwardPlatformLoggingEntries(
  entries: PlatformLogEntryPayload[]
): Promise<boolean> {
  if (!isTauri() || entries.length === 0) {
    return false
  }

  try {
    await invoke("platform_logging_forward", { entries })
    return true
  } catch {
    return false
  }
}

export async function getNativeLogDirectory(): Promise<string | null> {
  if (!isTauri()) {
    return null
  }

  try {
    return await invoke<string>("native_logging_get_log_directory")
  } catch {
    return null
  }
}

export async function openNativeLogDirectory(): Promise<boolean> {
  if (!isTauri()) {
    return false
  }

  try {
    await invoke("native_logging_open_log_directory")
    return true
  } catch {
    return false
  }
}

/** A single per-target level rule for the native (Rust) structured tracing layer. */
export interface TracingTargetLevel {
  target: string
  level: string
}

/** Status of the native structured tracing subscriber + its per-target rules. */
export interface TracingLevelsStatus {
  active: boolean
  defaultLevel: string
  rules: TracingTargetLevel[]
}

export async function getTracingLevels(): Promise<TracingLevelsStatus | null> {
  if (!isTauri()) {
    return null
  }

  try {
    return await invoke<TracingLevelsStatus>("tracing_logging_get_levels")
  } catch {
    return null
  }
}

/** Which on-disk desktop log file to query. */
export type NativeLogFileKind = "structured" | "plain"

/** Filter set for a native log read-back query. */
export interface NativeLogQueryInput {
  file?: NativeLogFileKind
  minLevel?: "trace" | "debug" | "info" | "warn" | "error"
  /** Hierarchy prefix match on the record target. */
  target?: string
  /** Case-insensitive substring match on the message. */
  contains?: string
  /** Only entries at or after this Unix-epoch timestamp (ms). */
  sinceMs?: number
  /** Result cap; server clamps to 1..=1000 (default 200). */
  limit?: number
}

/** One parsed native log record, normalized across both file formats. */
export interface NativeLogQueryEntry {
  timestamp: string
  epochMs?: number
  level: string
  target: string
  message: string
  fields?: Record<string, unknown>
}

/** Query result: newest-first entries plus scan metadata. */
export interface NativeLogQueryResult {
  entries: NativeLogQueryEntry[]
  fileSize: number
  scannedBytes: number
  truncated: boolean
  path: string
}

/** Metadata for one file in the desktop log directory. */
export interface NativeLogFileInfo {
  name: string
  size: number
  modifiedMs?: number
}

/**
 * Query the desktop's on-disk log files (bounded tail read, newest first).
 *
 * Goes through the unified transport, so it works on Tauri desktop (invoke)
 * AND on Capacitor mobile / web companion (companion RPC `logs_query`) —
 * a phone paired with a desktop reads the desktop's logs. Returns `null`
 * when no backend is reachable (plain web, unpaired companion, RPC error).
 */
export async function queryNativeLogs(
  query: NativeLogQueryInput = {}
): Promise<NativeLogQueryResult | null> {
  try {
    return await transport.call<NativeLogQueryResult>("logs_query", { query })
  } catch {
    return null
  }
}

/**
 * List the desktop log directory's files (live, rotated, structured),
 * newest-modified first. Same cross-platform semantics as {@link queryNativeLogs}.
 */
export async function listNativeLogFiles(): Promise<NativeLogFileInfo[] | null> {
  try {
    return await transport.call<NativeLogFileInfo[]>("logs_list_files", {})
  } catch {
    return null
  }
}

export async function setTracingLevels(
  rules: TracingTargetLevel[],
  defaultLevel?: string
): Promise<TracingLevelsStatus | null> {
  if (!isTauri()) {
    return null
  }

  try {
    return await invoke<TracingLevelsStatus>("tracing_logging_set_levels", { rules, defaultLevel })
  } catch {
    return null
  }
}
