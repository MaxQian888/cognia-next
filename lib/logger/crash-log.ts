import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"
import {
  DEFAULT_UNIFIED_CONFIG,
  LEVEL_PRIORITY,
  type LogLevel,
  type StructuredLogEntry,
} from "./types"

// cognia-next has no window-diagnostics or local-runtime subsystems yet, so
// the crash bundle treats these as semi-opaque shapes. They keep a small
// known-shape so downstream summary code can reason about them; everything
// else is preserved via the index signature for forward-compatibility.
export interface WindowDiagnosticsSnapshot {
  timestamp?: number
  totalWindows?: number
  [key: string]: unknown
}
export interface LocalRuntimeDiagnostics {
  status?: "ok" | "error" | "unknown"
  lastError?: string
  [key: string]: unknown
}

export type CrashLogSource = "recent" | "persisted" | "diagnostic"
export type CrashLogLevelFilter = "all" | LogLevel
export type CrashLogSourceFilter = "all" | CrashLogSource

export interface CrashDiagnosticsSnapshot {
  capturedAt: string
  nativeLogging: NativeLoggingReadiness | null
  windowDiagnostics: WindowDiagnosticsSnapshot | null
  localRuntimeDiagnostics: LocalRuntimeDiagnostics | null
  logDirectoryPath: string | null
  diagnosticsError: string | null
}

export interface CrashLogItem {
  id: string
  title: string
  summary: string
  timestamp: string
  level: LogLevel
  module: string
  sources: CrashLogSource[]
  traceId?: string
  logEntry?: StructuredLogEntry
  diagnostics?: CrashDiagnosticsSnapshot
}

export interface CrashLogExportFilters {
  source: CrashLogSourceFilter
  level: CrashLogLevelFilter
  search: string
}

export interface CrashLogExportBundle {
  exportedAt: string
  filters: CrashLogExportFilters
  diagnostics: CrashDiagnosticsSnapshot | null
  items: CrashLogItem[]
}

export interface CrashLogSummary {
  total: number
  byLevel: Record<LogLevel, number>
  bySource: Record<CrashLogSource, number>
  nativeLoggingStatus: NativeLoggingReadiness["status"] | "unavailable"
}

const SOURCE_ORDER: CrashLogSource[] = ["recent", "persisted", "diagnostic"]
const SAFE_REPLACEMENT = DEFAULT_UNIFIED_CONFIG.redaction.replacement
const SAFE_PATH_PATTERNS = [
  ...DEFAULT_UNIFIED_CONFIG.redaction.redactPatterns,
  "[A-Za-z]:\\\\(?:[^\\\\\\s]+\\\\)*[^\\\\\\s]+",
  "(?:/Users|/home|/var|/tmp|/private|/opt|/etc)(?:/[^\\s\"']+)+",
  "https?:\\/\\/[^\\s\"']+",
]
const SAFE_KEY_HINTS = new Set(
  [
    ...DEFAULT_UNIFIED_CONFIG.redaction.redactKeys,
    "path",
    "file",
    "directory",
    "url",
    "endpoint",
  ].map((key) => key.toLowerCase())
)

function mergeSources(current: CrashLogSource[], incoming: CrashLogSource): CrashLogSource[] {
  if (current.includes(incoming)) {
    return current
  }

  return [...current, incoming].sort(
    (left, right) => SOURCE_ORDER.indexOf(left) - SOURCE_ORDER.indexOf(right)
  )
}

function summarizeLog(log: StructuredLogEntry): string {
  if (log.stack) {
    return log.stack.split("\n")[0] || log.message
  }
  if (typeof log.data?.errorMessage === "string" && log.data.errorMessage.trim().length > 0) {
    return log.data.errorMessage.trim()
  }
  return log.message
}

function toTimestampValue(timestamp: string): number {
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? 0 : parsed
}

function deriveDiagnosticsSummary(diagnostics: CrashDiagnosticsSnapshot): string {
  if (diagnostics.diagnosticsError) {
    return diagnostics.diagnosticsError
  }
  if (diagnostics.localRuntimeDiagnostics?.status === "error") {
    return diagnostics.localRuntimeDiagnostics.lastError || "Local runtime reported an error"
  }
  if (diagnostics.nativeLogging?.status === "degraded") {
    return diagnostics.nativeLogging.fallbackReason?.message || "Native logging is degraded"
  }
  if (diagnostics.nativeLogging?.status === "inactive") {
    return "Native logging is inactive in the current runtime"
  }
  return "Latest native diagnostics snapshot"
}

export function isCrashRelevantLogEntry(log: StructuredLogEntry): boolean {
  if (log.level === "error" || log.level === "fatal") {
    return true
  }

  return (
    log.level === "warn" &&
    (log.origin === "diagnostic" ||
      log.module === "logger.internal" ||
      typeof log.data?.sourceTransport === "string")
  )
}

function deriveDiagnosticsLevel(diagnostics: CrashDiagnosticsSnapshot): LogLevel {
  if (diagnostics.diagnosticsError || diagnostics.localRuntimeDiagnostics?.status === "error") {
    return "error"
  }
  if (diagnostics.nativeLogging?.status === "degraded") {
    return "warn"
  }
  return "info"
}

function shouldAddDiagnosticsItem(
  diagnostics: CrashDiagnosticsSnapshot | null
): diagnostics is CrashDiagnosticsSnapshot {
  if (!diagnostics) {
    return false
  }

  return Boolean(
    diagnostics.diagnosticsError ||
    diagnostics.nativeLogging?.status === "degraded" ||
    diagnostics.localRuntimeDiagnostics?.status === "error"
  )
}

function sanitizeText(value: string): string {
  return SAFE_PATH_PATTERNS.reduce((current, pattern) => {
    try {
      return current.replace(new RegExp(pattern, "gi"), SAFE_REPLACEMENT)
    } catch {
      return current
    }
  }, value)
}

function sanitizeValue(value: unknown, keyHint?: string): unknown {
  if (keyHint && SAFE_KEY_HINTS.has(keyHint.toLowerCase())) {
    return SAFE_REPLACEMENT
  }

  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === "string") {
    return sanitizeText(value)
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item))
  }

  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = sanitizeValue(nested, key)
    }
    return sanitized
  }

  return value
}

function sanitizeLogEntry(logEntry: StructuredLogEntry): StructuredLogEntry {
  return {
    ...logEntry,
    message: sanitizeText(logEntry.message),
    stack: logEntry.stack ? sanitizeText(logEntry.stack) : logEntry.stack,
    data: logEntry.data ? (sanitizeValue(logEntry.data) as Record<string, unknown>) : logEntry.data,
  }
}

function sanitizeCrashLogItem(item: CrashLogItem): CrashLogItem {
  return {
    ...item,
    title: sanitizeText(item.title),
    summary: sanitizeText(item.summary),
    logEntry: item.logEntry ? sanitizeLogEntry(item.logEntry) : item.logEntry,
    diagnostics: item.diagnostics
      ? (sanitizeValue(item.diagnostics) as CrashDiagnosticsSnapshot)
      : item.diagnostics,
  }
}

export function buildCrashLogItems(params: {
  recentErrors: StructuredLogEntry[]
  persistedLogs: StructuredLogEntry[]
  diagnostics: CrashDiagnosticsSnapshot | null
}): CrashLogItem[] {
  const merged = new Map<string, CrashLogItem>()

  const upsert = (log: StructuredLogEntry, source: CrashLogSource) => {
    const current = merged.get(log.id)
    const next: CrashLogItem = current
      ? {
          ...current,
          sources: mergeSources(current.sources, source),
          diagnostics: current.diagnostics ?? params.diagnostics ?? undefined,
        }
      : {
          id: log.id,
          title: log.message,
          summary: summarizeLog(log),
          timestamp: log.timestamp,
          level: log.level,
          module: log.module,
          sources: [source],
          traceId: log.traceId,
          logEntry: log,
          diagnostics: params.diagnostics ?? undefined,
        }

    merged.set(log.id, next)
  }

  for (const log of params.recentErrors) {
    upsert(log, "recent")
  }

  for (const log of params.persistedLogs) {
    if (isCrashRelevantLogEntry(log)) {
      upsert(log, "persisted")
    }
  }

  const items = [...merged.values()]

  if (shouldAddDiagnosticsItem(params.diagnostics)) {
    items.push({
      id: "crash:diagnostic-snapshot",
      title: "Diagnostic snapshot",
      summary: deriveDiagnosticsSummary(params.diagnostics),
      timestamp: params.diagnostics.capturedAt,
      level: deriveDiagnosticsLevel(params.diagnostics),
      module: "native",
      sources: ["diagnostic"],
      diagnostics: params.diagnostics,
    })
  }

  return items.sort((left, right) => {
    const byTimestamp = toTimestampValue(right.timestamp) - toTimestampValue(left.timestamp)
    if (byTimestamp !== 0) {
      return byTimestamp
    }

    return LEVEL_PRIORITY[right.level] - LEVEL_PRIORITY[left.level]
  })
}

export function summarizeCrashLogItems(
  items: CrashLogItem[],
  diagnostics: CrashDiagnosticsSnapshot | null
): CrashLogSummary {
  const byLevel: CrashLogSummary["byLevel"] = {
    trace: 0,
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
    fatal: 0,
  }
  const bySource: CrashLogSummary["bySource"] = {
    recent: 0,
    persisted: 0,
    diagnostic: 0,
  }

  for (const item of items) {
    byLevel[item.level] += 1
    for (const source of item.sources) {
      bySource[source] += 1
    }
  }

  return {
    total: items.length,
    byLevel,
    bySource,
    nativeLoggingStatus: diagnostics?.nativeLogging?.status ?? "unavailable",
  }
}

export function buildCrashLogExportBundle(params: {
  items: CrashLogItem[]
  diagnostics: CrashDiagnosticsSnapshot | null
  exportedAt: string
  filters: CrashLogExportFilters
}): CrashLogExportBundle {
  return {
    exportedAt: params.exportedAt,
    filters: params.filters,
    diagnostics: params.diagnostics
      ? (sanitizeValue(params.diagnostics) as CrashDiagnosticsSnapshot)
      : null,
    items: params.items.map((item) => sanitizeCrashLogItem(item)),
  }
}
