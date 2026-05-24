import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"

/**
 * Thin wrappers over the Rust `crash::commands` surface. All are no-ops off the
 * desktop runtime (web / mobile) — the crash-report subsystem only exists under
 * Tauri. Mirrors the invoke-wrapper style of `native-logging.ts`.
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

export async function listCrashReports(): Promise<CrashReportSummary[]> {
  if (!isTauri()) return []
  try {
    return await invoke<CrashReportSummary[]>("crash_list_reports")
  } catch {
    return []
  }
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
