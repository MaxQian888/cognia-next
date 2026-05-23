/**
 * Crash Log Types
 */

import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"
import type { LogLevel } from "./log-level"
import type { StructuredLogEntry } from "./log-entry"

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

export type CrashLogExportFormat = "bundle" | "json" | "text"

export interface SerializedCrashLogExport {
  filename: string
  content: string
  mimeType: string
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

export interface UseCrashLogsResult {
  isLoading: boolean
  isRefreshing: boolean
  error: Error | null
  autoRefresh: boolean
  setAutoRefresh: (value: boolean) => void
  lastUpdatedAt: string | null
  filters: {
    source: CrashLogSourceFilter
    level: CrashLogLevelFilter
    search: string
  }
  setSourceFilter: (value: CrashLogSourceFilter) => void
  setLevelFilter: (value: CrashLogLevelFilter) => void
  setSearchQuery: (value: string) => void
  items: CrashLogItem[]
  selectedItem: CrashLogItem | null
  relatedLogs: NonNullable<CrashLogItem["logEntry"]>[]
  selectItem: (itemId: string) => void
  refresh: () => Promise<void>
  clearRecent: () => void
  clearPersisted: () => Promise<void>
  copySelected: () => Promise<boolean>
  exportBundle: (format?: CrashLogExportFormat) => void
  openNativeLogDirectory: () => Promise<boolean>
  summary: CrashLogSummary
}
