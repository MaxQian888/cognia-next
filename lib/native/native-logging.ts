import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
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
