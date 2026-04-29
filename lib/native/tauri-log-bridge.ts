/**
 * Tauri Log Bridge
 *
 * Bridges Rust backend logs to the frontend unified logging system.
 */

import { createLogRuntimeContext, logContext, loggers, type LogLevel } from "@/lib/logger"
import { isTauri } from "@/lib/tauri"
import { updateNativeLoggingReadiness } from "./native-logging-readiness"

export interface TauriLogEvent {
  level: string
  target: string
  message: string
  timestamp: string
  traceId?: string
  data?: Record<string, unknown>
}

function readString(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

function readObject(
  raw: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        // ignore
      }
    }
  }
  return undefined
}

function mapLogLevel(rustLevel: string): LogLevel {
  const level = rustLevel.toUpperCase()
  switch (level) {
    case "TRACE":
      return "trace"
    case "DEBUG":
      return "debug"
    case "INFO":
      return "info"
    case "WARN":
    case "WARNING":
      return "warn"
    case "ERROR":
      return "error"
    case "FATAL":
      return "fatal"
    default:
      return "info"
  }
}

function parseTarget(target: string): string {
  return target.replace(/^app_lib::/, "").replace(/::/g, ":")
}

function normalizeEvent(payload: unknown): TauriLogEvent | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const raw = payload as Record<string, unknown>
  const level = readString(raw, ["level", "lvl", "severity"]) || "INFO"
  const target = readString(raw, ["target", "module", "modulePath", "logger"]) || "tauri"
  const message =
    readString(raw, ["message", "msg", "body"]) ||
    readString(raw, ["error", "reason"]) ||
    "[tauri log]"
  const timestamp =
    readString(raw, ["timestamp", "time", "ts", "createdAt"]) || new Date().toISOString()
  const traceId = readString(raw, [
    "traceId",
    "trace_id",
    "requestId",
    "request_id",
    "correlationId",
  ])
  const data = readObject(raw, ["data", "meta", "metadata", "context"])

  return {
    level,
    target,
    message,
    timestamp,
    traceId,
    data,
  }
}

function routeLog(event: TauriLogEvent): void {
  const logLevel = mapLogLevel(event.level)
  const moduleName = parseTarget(event.target)
  const logData: Record<string, unknown> = createLogRuntimeContext({
    runtime: "tauri",
    origin: "tauri",
    source: "tauri",
    target: event.target,
    tauriTimestamp: event.timestamp,
    tags: ["native", "tauri"],
    ...(event.data || {}),
  })

  if (event.traceId) {
    logContext.setTraceId(event.traceId)
  }

  const logger = loggers.native.child(moduleName)
  switch (logLevel) {
    case "trace":
      logger.trace(event.message, logData)
      break
    case "debug":
      logger.debug(event.message, logData)
      break
    case "info":
      logger.info(event.message, logData)
      break
    case "warn":
      logger.warn(event.message, logData)
      break
    case "error":
      logger.error(event.message, undefined, logData)
      break
    case "fatal":
      logger.fatal(event.message, undefined, logData)
      break
  }

  if (event.traceId) {
    logContext.clearTraceId()
  }
}

let isInitialized = false
let unlistenFn: (() => void | Promise<void>) | null = null
let bridgeStatus: TauriLogBridgeStatus = {
  state: "inactive",
  updatedAt: new Date().toISOString(),
}

function setBridgeStatus(next: Partial<TauriLogBridgeStatus>): void {
  bridgeStatus = {
    ...bridgeStatus,
    ...next,
    updatedAt: new Date().toISOString(),
  }
}

export async function initTauriLogBridge(): Promise<void> {
  if (!isTauri()) {
    setBridgeStatus({
      state: "inactive",
      initializedAt: undefined,
      lastError: undefined,
    })
    return
  }
  if (isInitialized) return

  try {
    const { listen } = await import("@tauri-apps/api/event")

    unlistenFn = await listen<unknown>("log://log", (event) => {
      const parsed = normalizeEvent(event.payload)
      if (!parsed) {
        return
      }
      routeLog(parsed)
    })

    isInitialized = true
    setBridgeStatus({
      state: "active",
      initializedAt: new Date().toISOString(),
      lastError: undefined,
    })
    updateNativeLoggingReadiness({
      runtime: "tauri",
      bridgeState: "active",
      bridgeLastError: null,
    })
    loggers.native.info(
      "Tauri log bridge initialized",
      createLogRuntimeContext({
        runtime: "tauri",
        origin: "tauri",
        tags: ["native", "tauri"],
      })
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setBridgeStatus({
      state: "degraded",
      lastError: message,
    })
    updateNativeLoggingReadiness({
      runtime: "tauri",
      bridgeState: "degraded",
      bridgeLastError: message,
    })
    loggers.native.error(
      "Failed to initialize Tauri log bridge",
      error as Error,
      createLogRuntimeContext({
        runtime: "tauri",
        origin: "tauri",
        tags: ["native", "tauri"],
      })
    )
  }
}

export interface TauriLogBridgeStatus {
  state: "active" | "inactive" | "degraded"
  initializedAt?: string
  updatedAt: string
  lastError?: string
}

export async function cleanupTauriLogBridge(): Promise<void> {
  if (unlistenFn) {
    await Promise.resolve(unlistenFn())
    unlistenFn = null
  }
  isInitialized = false
  setBridgeStatus({
    state: "inactive",
    initializedAt: undefined,
    lastError: undefined,
  })
  updateNativeLoggingReadiness({
    bridgeState: "inactive",
    bridgeLastError: null,
  })
}

export function isTauriLogBridgeActive(): boolean {
  return isInitialized
}

export function getTauriLogBridgeStatus(): TauriLogBridgeStatus {
  return bridgeStatus
}

export function forwardTauriLog(event: TauriLogEvent | Record<string, unknown>): void {
  const parsed = normalizeEvent(event)
  if (!parsed) {
    return
  }
  routeLog(parsed)
}
