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

// ---------------------------------------------------------------------------
// Hero bar segments
// ---------------------------------------------------------------------------

export interface UsageSegmentSource {
  category: string
  totalSize: number
}

/** Category id of the merged tail segment. */
export const REST_SEGMENT = "rest"

export interface UsageSegment {
  /**
   * A `StorageCategory`, or `"rest"` for the merged tail. Not `"other"`:
   * that is a real category, and reusing it collided keys in the legend.
   */
  category: string
  /** Bytes this segment stands for. */
  bytes: number
  /** Width as a percentage of the whole bar track (0–100). */
  widthPercent: number
  /** Share of the used space (0–100). */
  sharePercent: number
}

export interface UsageSegments {
  /** Filled portion of the track (0–100). 100 when the quota is unknown. */
  fillPercent: number
  /** True when the browser reported both a usage and a quota. */
  quotaKnown: boolean
  segments: UsageSegment[]
}

export interface ComputeUsageSegmentsInput {
  /** `navigator.storage.estimate()` result; either half may be null. */
  totalBytes: number | null
  quotaBytes: number | null
  /** Per-category sizes from the Dexie walk (`StorageStats.byCategory`). */
  categories: readonly UsageSegmentSource[]
  /** Segments to draw before merging the tail into `"rest"`. */
  maxSegments?: number
}

/**
 * Splits one bar into per-category segments that also convey how full the
 * origin is.
 *
 * The track is the quota. The filled part is `totalBytes / quotaBytes`.
 * Inside the filled part, categories share the width in proportion to their
 * Dexie size — the origin estimate includes caches the walk cannot see, so
 * the category sizes are scaled to the filled width rather than drawn raw.
 * Without a quota the whole track is the used space and segments sum to 100.
 */
export function computeUsageSegments(input: ComputeUsageSegmentsInput): UsageSegments {
  const maxSegments = input.maxSegments ?? 5
  const quotaKnown =
    typeof input.totalBytes === "number" &&
    typeof input.quotaBytes === "number" &&
    input.quotaBytes > 0
  const fillPercent = quotaKnown
    ? Math.min(100, Math.max(0, ((input.totalBytes ?? 0) / (input.quotaBytes ?? 1)) * 100))
    : 100

  const sorted = input.categories
    .filter((c) => c.totalSize > 0)
    .slice()
    .sort((a, b) => b.totalSize - a.totalSize)
  const used = sorted.reduce((s, c) => s + c.totalSize, 0)

  if (used <= 0) {
    return { fillPercent, quotaKnown, segments: [] }
  }

  const head = sorted.slice(0, maxSegments)
  const tail = sorted.slice(maxSegments)
  const tailBytes = tail.reduce((s, c) => s + c.totalSize, 0)
  const sources: UsageSegmentSource[] =
    tailBytes > 0 ? [...head, { category: REST_SEGMENT, totalSize: tailBytes }] : head

  const segments = sources.map((c) => {
    const share = (c.totalSize / used) * 100
    return {
      category: c.category,
      bytes: c.totalSize,
      sharePercent: share,
      widthPercent: (share / 100) * fillPercent,
    }
  })

  return { fillPercent, quotaKnown, segments }
}
