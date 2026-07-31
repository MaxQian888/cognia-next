import {
  DEFAULT_UNIFIED_CONFIG,
  LEVEL_PRIORITY,
  type LogLevel,
  type StructuredLogEntry,
  type CrashDiagnosticsSnapshot,
  type CrashLogItem,
  type CrashLogExportFilters,
  type CrashLogExportBundle,
  type CrashLogSource,
  type CrashLogSummary,
} from "@/types/logging"
import { downloadFile } from "@/lib/files/download"
import {
  CRASH_LOG_KEY_HINTS,
  CRASH_LOG_TEXT_REDACTION_PATTERNS,
} from "@cognia/logging/redaction-patterns"

export type {
  WindowDiagnosticsSnapshot,
  LocalRuntimeDiagnostics,
  CrashLogSource,
  CrashLogLevelFilter,
  CrashLogSourceFilter,
  CrashDiagnosticsSnapshot,
  CrashLogItem,
  CrashLogExportFilters,
  CrashLogExportBundle,
  CrashLogSummary,
} from "@/types/logging"

const SOURCE_ORDER: CrashLogSource[] = ["recent", "persisted", "diagnostic"]
const SAFE_REPLACEMENT = DEFAULT_UNIFIED_CONFIG.redaction.replacement
const SAFE_KEY_HINTS = new Set(CRASH_LOG_KEY_HINTS.map((key) => key.toLowerCase()))

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
  return CRASH_LOG_TEXT_REDACTION_PATTERNS.reduce((current, pattern) => {
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

export type CrashLogExportFormat = "bundle" | "json" | "text"

export interface SerializedCrashLogExport {
  filename: string
  content: string
  mimeType: string
}

/**
 * Pure serializer shared by `useCrashLogs.exportBundle` and
 * `exportCrashLogBundleNow`. Single source of truth for filename / mime / payload
 * per format so the on-page "Export crash log" CTA produces byte-identical files
 * to the Logs page export.
 */
export function serializeCrashLogBundle(
  bundle: CrashLogExportBundle,
  format: CrashLogExportFormat = "bundle"
): SerializedCrashLogExport {
  const datePart = new Date().toISOString().slice(0, 10)

  if (format === "json") {
    return {
      filename: `cognia-crash-logs-${datePart}.json`,
      content: JSON.stringify(
        bundle.items.map((item) => item.logEntry ?? item),
        null,
        2
      ),
      mimeType: "application/json",
    }
  }

  if (format === "text") {
    return {
      filename: `cognia-crash-logs-${datePart}.txt`,
      content: bundle.items
        .map(
          (item) => `${item.timestamp} [${item.level.toUpperCase()}] ${item.module} ${item.title}`
        )
        .join("\n"),
      mimeType: "text/plain",
    }
  }

  return {
    filename: `cognia-crash-bundle-${datePart}.json`,
    content: JSON.stringify(bundle, null, 2),
    mimeType: "application/json",
  }
}

export interface ExportCrashLogBundleNowOptions {
  /**
   * Error that triggered the export (typically the `error` prop of an
   * App-Router `error.tsx` / `global-error.tsx` boundary). When provided it is
   * recorded into the in-memory recent-errors stream first so the assembled
   * bundle includes this crash even if the renderer never ran the regular
   * logger transport path.
   */
  triggerError?: Error & { digest?: string }
  /** Logger module recorded against the synthetic trigger entry. Default "app". */
  subsystem?: string
  format?: CrashLogExportFormat
  /** Override the auto-generated filename (extension preserved by caller). */
  filename?: string
}

/**
 * One-shot crash-log export for use inside route-level error boundaries.
 *
 * Mirrors `useCrashLogs.exportBundle` but without React state / subscriptions:
 * gathers recent errors, persisted logs (via IndexedDB transport), and native
 * diagnostics in a single async pass, then triggers a browser download via
 * `lib/files/download.ts::downloadFile`. Browser-only.
 */
export async function exportCrashLogBundleNow(
  opts: ExportCrashLogBundleNowOptions = {}
): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("exportCrashLogBundleNow requires a browser environment")
  }

  // Lazy-load the runtime dependencies so this module remains tree-shakable for
  // any consumer that only imports the pure helpers above.
  const [
    { getRecentErrorLogs, recordRecentErrorLog },
    { getIndexedDBTransport },
    { getNativeLoggingReadiness, getNativeLoggingReadinessSnapshot, getNativeLogDirectory },
    { getLocalRuntimeDiagnostics },
    { getWindowDiagnostics },
  ] = await Promise.all([
    import("@cognia/logging/recent-errors"),
    import("./bootstrap"),
    import("@/lib/native/native-logging"),
    import("@/lib/native/local-runtime"),
    import("@/lib/native/window-diagnostics"),
  ])

  if (opts.triggerError) {
    const nowIso = new Date().toISOString()
    const message = opts.triggerError.message || opts.triggerError.name || "Route boundary error"
    recordRecentErrorLog({
      id: `crash-trigger:${opts.triggerError.digest ?? nowIso}`,
      timestamp: nowIso,
      level: "error",
      module: opts.subsystem ?? "app",
      message,
      stack: opts.triggerError.stack,
      origin: "frontend",
      data: opts.triggerError.digest ? { digest: opts.triggerError.digest } : undefined,
    })
  }

  const recentErrors = getRecentErrorLogs()

  let persistedLogs: StructuredLogEntry[] = []
  try {
    const transport = getIndexedDBTransport()
    if (transport) {
      persistedLogs = await transport.getLogs({ limit: 400 })
    }
  } catch {
    persistedLogs = []
  }

  let diagnostics: CrashDiagnosticsSnapshot | null = null
  try {
    await getNativeLoggingReadiness()
    const [windowDiagnostics, localRuntimeDiagnostics, logDirectoryPath] = await Promise.all([
      getWindowDiagnostics().catch(() => null),
      getLocalRuntimeDiagnostics().catch(() => null),
      getNativeLogDirectory().catch(() => null),
    ])
    diagnostics = {
      capturedAt: new Date().toISOString(),
      nativeLogging: getNativeLoggingReadinessSnapshot(),
      windowDiagnostics,
      localRuntimeDiagnostics,
      logDirectoryPath,
      diagnosticsError: null,
    }
  } catch (err) {
    diagnostics = {
      capturedAt: new Date().toISOString(),
      nativeLogging: getNativeLoggingReadinessSnapshot(),
      windowDiagnostics: null,
      localRuntimeDiagnostics: null,
      logDirectoryPath: null,
      diagnosticsError: err instanceof Error ? err.message : String(err),
    }
  }

  const items = buildCrashLogItems({
    recentErrors,
    persistedLogs: persistedLogs.filter(isCrashRelevantLogEntry),
    diagnostics,
  })
  const bundle = buildCrashLogExportBundle({
    items,
    diagnostics,
    exportedAt: new Date().toISOString(),
    filters: { source: "all", level: "all", search: "" },
  })

  const serialized = serializeCrashLogBundle(bundle, opts.format ?? "bundle")
  downloadFile(opts.filename ?? serialized.filename, serialized.content, serialized.mimeType)
}
