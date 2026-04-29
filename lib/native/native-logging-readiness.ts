export type NativeLoggingRuntime = "web" | "tauri"
export type NativeLoggingStatus = "healthy" | "degraded" | "inactive"
export type NativeLoggingStartupMode = "full" | "fallback" | "disabled" | "unknown"
export type NativeLoggingStartupHealth = "healthy" | "degraded" | "inactive"
export type NativeLoggingBridgeState = "active" | "inactive" | "degraded"
export type PlatformLoggingHealth = "healthy" | "degraded" | "inactive"
export type PlatformLoggingLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export interface PlatformLoggingStatus {
  available: boolean
  backend: string
  health: PlatformLoggingHealth
  error?: string
  enabled: boolean
  minLevel: PlatformLoggingLevel
}

export interface NativeLoggingFallbackReason {
  code: string
  message: string
}

export interface NativeLoggingReadiness {
  runtime: NativeLoggingRuntime
  status: NativeLoggingStatus
  startupMode: NativeLoggingStartupMode
  startupHealth: NativeLoggingStartupHealth
  activeTargets: string[]
  bridgeState: NativeLoggingBridgeState
  platformLogging: PlatformLoggingStatus
  fallbackReason?: NativeLoggingFallbackReason
  bridgeLastError?: string
  checkedAt?: string
  updatedAt: string
}

export interface NativeLoggingReadinessUpdate {
  runtime?: NativeLoggingRuntime
  startupMode?: NativeLoggingStartupMode
  startupHealth?: NativeLoggingStartupHealth
  activeTargets?: string[]
  bridgeState?: NativeLoggingBridgeState
  platformLogging?: PlatformLoggingStatus
  fallbackReason?: NativeLoggingFallbackReason | null
  bridgeLastError?: string | null
  checkedAt?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

const DEFAULT_NATIVE_LOGGING_READINESS: NativeLoggingReadiness = {
  runtime: "web",
  status: "inactive",
  startupMode: "disabled",
  startupHealth: "inactive",
  activeTargets: [],
  bridgeState: "inactive",
  platformLogging: {
    available: false,
    backend: "none",
    health: "inactive",
    enabled: true,
    minLevel: "warn",
  },
  updatedAt: nowIso(),
}

let currentNativeLoggingReadiness: NativeLoggingReadiness = {
  ...DEFAULT_NATIVE_LOGGING_READINESS,
}

function deriveNativeLoggingStatus(
  readiness: Omit<NativeLoggingReadiness, "status">
): NativeLoggingStatus {
  if (readiness.runtime !== "tauri") {
    return "inactive"
  }

  if (
    readiness.startupMode === "fallback" ||
    readiness.startupHealth === "degraded" ||
    readiness.bridgeState === "degraded" ||
    readiness.platformLogging.health === "degraded" ||
    !!readiness.fallbackReason ||
    !!readiness.bridgeLastError
  ) {
    return "degraded"
  }

  if (
    readiness.startupMode === "full" &&
    readiness.startupHealth === "healthy" &&
    readiness.bridgeState === "active"
  ) {
    return "healthy"
  }

  return "inactive"
}

export function updateNativeLoggingReadiness(
  update: NativeLoggingReadinessUpdate
): NativeLoggingReadiness {
  const nextWithoutStatus: Omit<NativeLoggingReadiness, "status"> = {
    runtime: update.runtime ?? currentNativeLoggingReadiness.runtime,
    startupMode: update.startupMode ?? currentNativeLoggingReadiness.startupMode,
    startupHealth: update.startupHealth ?? currentNativeLoggingReadiness.startupHealth,
    activeTargets: update.activeTargets ?? currentNativeLoggingReadiness.activeTargets,
    bridgeState: update.bridgeState ?? currentNativeLoggingReadiness.bridgeState,
    platformLogging: update.platformLogging ?? currentNativeLoggingReadiness.platformLogging,
    fallbackReason:
      update.fallbackReason === null
        ? undefined
        : (update.fallbackReason ?? currentNativeLoggingReadiness.fallbackReason),
    bridgeLastError:
      update.bridgeLastError === null
        ? undefined
        : (update.bridgeLastError ?? currentNativeLoggingReadiness.bridgeLastError),
    checkedAt: update.checkedAt ?? currentNativeLoggingReadiness.checkedAt,
    updatedAt: nowIso(),
  }

  currentNativeLoggingReadiness = {
    ...nextWithoutStatus,
    status: deriveNativeLoggingStatus(nextWithoutStatus),
  }

  return currentNativeLoggingReadiness
}

export function getNativeLoggingReadiness(): NativeLoggingReadiness {
  return currentNativeLoggingReadiness
}

export function resetNativeLoggingReadinessForTest(): void {
  currentNativeLoggingReadiness = {
    ...DEFAULT_NATIVE_LOGGING_READINESS,
    updatedAt: nowIso(),
  }
}
