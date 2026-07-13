/**
 * Crash Log Types
 */

import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"
import type { LogLevel } from "@cognia/logging/types/log-level"
import type { StructuredLogEntry } from "@cognia/logging/types/log-entry"

// Window-diagnostics and local-runtime snapshots come from `lib/native/*` at
// crash-export time. They keep a small known shape so downstream summary code
// can reason about them; everything else is preserved via the index signature
// for forward-compatibility.
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

/**
 * Native crash-report (`.json` sidecar) written by the Rust crash subsystem —
 * mirrors `crash::report::CrashReport`'s serde output. Distinct from the
 * frontend on-demand {@link CrashLogExportBundle}: these are self-contained
 * reports produced by the panic hook / out-of-process minidump monitor and
 * surfaced read-only in the diagnostics panel.
 */
export interface NativeCrashReportSystem {
  os: string
  osVersion?: string | null
  kernelVersion?: string | null
  arch: string
  family: string
  hostname?: string | null
  cpu?: string | null
  cpuCount: number
  totalMemoryBytes: number
  usedMemoryBytes: number
  appVersion: string
  tauriVersion: string
  profile: string
  enabledFeatures: string[]
}

export interface NativeCrashBreadcrumb {
  at: string
  level: string
  message: string
}

export interface NativeCrashReport {
  kind: "panic" | "native"
  capturedAt: string
  thread?: string | null
  message: string
  location?: string | null
  backtrace?: string
  dumpPath?: string
  system: NativeCrashReportSystem
  context: {
    config: unknown
    breadcrumbs: NativeCrashBreadcrumb[]
  }
  extra: unknown
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
