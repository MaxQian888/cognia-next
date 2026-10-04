import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"

/**
 * Thin wrappers over the Rust `crash::commands` surface. All are no-ops off the
 * desktop runtime (web / mobile) — the crash-report subsystem only exists under
 * Tauri. Mirrors the invoke-wrapper style of `native-logging.ts`.
 *
 * One exception to "swallow and default": `listCrashReports` rethrows a failed
 * invoke. It used to answer `[]`, which the `/logs` Crash reports channel then
 * rendered as "no crash reports" — indistinguishable from a healthy machine —
 * when the truth was that the crash directory could not be read at all.
 */

/** One report on disk, grouped by stem (shared by its `.txt` / `.json` / `.dmp`). */
export interface CrashReportSummary {
  stem: string
  capturedAt?: string
  kind?: string
  hasTxt: boolean
  hasJson: boolean
  hasDmp: boolean
  sizeBytes: number
}

/** Info about an abnormal previous exit, surfaced once via the next-launch dialog. */
export interface PendingCrash {
  startedAt: string
  version: string
  latestReportStem?: string
  reportCount: number
}

/** Aggregated crash + log health for the diagnostics surfaces. */
export interface CrashLoggingDiagnostics {
  crashReportCount: number
  latestCrashAt?: string
  latestCrashKind?: string
  logDirBytes: number
  retentionMaxAgeDays: number
  retentionMaxReports: number
  rotatedLogKeep: number
  lastPrunePruned?: number
  lastPruneRemaining?: number
}

/**
 * Every report on disk. `[]` off the desktop runtime, where there is nothing
 * to list; a rejected invoke on the desktop propagates so the caller can say
 * "could not read" instead of "nothing crashed".
 */
export async function listCrashReports(): Promise<CrashReportSummary[]> {
  if (!isTauri()) return []
  return invoke<CrashReportSummary[]>("crash_list_reports")
}

export async function readCrashReport(stem: string): Promise<string | null> {
  if (!isTauri()) return null
  try {
    return await invoke<string>("crash_read_report", { stem })
  } catch {
    return null
  }
}

export async function openCrashReportDir(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("crash_open_report_dir")
    return true
  } catch {
    return false
  }
}

export async function deleteCrashReport(stem: string): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("crash_delete_report", { stem })
    return true
  } catch {
    return false
  }
}

export async function takePendingCrash(): Promise<PendingCrash | null> {
  if (!isTauri()) return null
  try {
    return await invoke<PendingCrash | null>("crash_take_pending")
  } catch {
    return null
  }
}

export async function getCrashLoggingDiagnostics(): Promise<CrashLoggingDiagnostics | null> {
  if (!isTauri()) return null
  try {
    return await invoke<CrashLoggingDiagnostics>("crash_logging_diagnostics")
  } catch {
    return null
  }
}
