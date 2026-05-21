"use client"

/**
 * Storage-usage helper for the mobile `/me/storage` page.
 *
 * Combines:
 *   • `navigator.storage.estimate()` for the Dexie + cache total
 *     ("usage" / "quota"). Available on all modern browsers / Capacitor
 *     WebViews; unavailable on jsdom + older Tauri webviews.
 *   • Sum of `BackupHistoryRow.sizeBytes` across local backup history,
 *     so the user sees how much disk they have dedicated to encrypted
 *     exports (file-size is recorded at append time).
 *
 * Never throws — every backend is allowed to fail independently and we
 * report `null` for missing dimensions so the UI can render an explicit
 * "unsupported" state instead of empty zeros.
 */

import { listBackupHistory, type BackupHistoryRow } from "@/lib/db/backup-history"

export interface StorageUsage {
  /** Total bytes the browser reports for our origin (Dexie + caches). */
  totalBytes: number | null
  /** Quota the browser is willing to grant us. */
  quotaBytes: number | null
  /** Aggregate size of all backup files on disk we know about. */
  backupBytes: number | null
  /** Newest-first list of backup rows that contributed to `backupBytes`. */
  backups: BackupHistoryRow[]
}

export interface GetStorageUsageOptions {
  estimator?: () => Promise<{ usage?: number; quota?: number }>
  loadBackups?: () => Promise<BackupHistoryRow[]>
}

async function defaultEstimator(): Promise<{ usage?: number; quota?: number }> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return {}
  }
  return navigator.storage.estimate()
}

export async function getStorageUsage(opts: GetStorageUsageOptions = {}): Promise<StorageUsage> {
  const estimate = opts.estimator ?? defaultEstimator
  const loader = opts.loadBackups ?? (() => listBackupHistory({ successOnly: true }))

  let totalBytes: number | null = null
  let quotaBytes: number | null = null
  try {
    const out = await estimate()
    totalBytes = typeof out.usage === "number" ? out.usage : null
    quotaBytes = typeof out.quota === "number" ? out.quota : null
  } catch {
    // Browser refused to estimate (private mode, etc.) — fall through.
  }

  let backupBytes: number | null = null
  let backups: BackupHistoryRow[] = []
  try {
    backups = await loader()
    backupBytes = backups.reduce(
      (acc, row) => (typeof row.sizeBytes === "number" ? acc + row.sizeBytes : acc),
      0
    )
  } catch {
    backupBytes = null
  }

  return { totalBytes, quotaBytes, backupBytes, backups }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
