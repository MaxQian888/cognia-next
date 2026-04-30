// Category-scoped cleanup operations. The Maintenance tab's
// `StorageCleanupDialog` calls these to free space without nuking everything
// (use `StorageManager.clearAllCogniaData()` for that).
//
// Three flavors:
//   - cleanupCategories: targeted, deletes the user-selected buckets.
//   - quickCleanup: wipes the cache-equivalent rows we know are safe to drop
//     (the `tts_provider_keys` web fallback, anything in the `system` bucket).
//   - deepCleanup: aggressive — drops messages older than 7d that belong to
//     sessions still kept (i.e. truncates conversation tails). Always offered
//     as the most destructive option in the dialog.
//
// `previewCleanup` runs the same accounting without writing, so the dialog
// can show "this will free ~X MB" before the user commits.

import { getDb } from "@/lib/db/schema"
import { CATEGORY_INFO } from "./category-info"
import type { CleanupDetail, CleanupOptions, CleanupResult, StorageCategory } from "./types"

const DEEP_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Estimate per-row byte cost; identical to the storage-manager helper. */
function rowSize(row: unknown): number {
  try {
    return JSON.stringify(row).length
  } catch {
    return 0
  }
}

function emptyResult(): CleanupResult {
  return { freedSpace: 0, deletedItems: 0, details: [], errors: [] }
}

async function categoryStats(
  category: StorageCategory,
  olderThan?: number
): Promise<CleanupDetail> {
  const db = getDb()
  const tables = CATEGORY_INFO[category].tables
  let deletedItems = 0
  let freedSpace = 0
  for (const tableName of tables) {
    const table = db.tables.find((t) => t.name === tableName)
    if (!table) continue
    try {
      const rows = await table.toArray()
      for (const row of rows) {
        const completedAt = (row as { completedAt?: number }).completedAt
        const updatedAt = (row as { updatedAt?: number }).updatedAt
        const ts =
          (typeof completedAt === "number" ? completedAt : undefined) ??
          (typeof updatedAt === "number" ? updatedAt : undefined)
        if (typeof olderThan === "number" && ts !== undefined && ts > olderThan) {
          continue
        }
        deletedItems += 1
        freedSpace += rowSize(row)
      }
    } catch {
      // Skip the table; the caller's preview will show whatever we managed to read.
    }
  }
  return { category, deletedItems, freedSpace }
}

async function applyCategoryDelete(
  category: StorageCategory,
  olderThan?: number
): Promise<{ deletedItems: number; freedSpace: number; error?: string }> {
  const db = getDb()
  const tables = CATEGORY_INFO[category].tables
  let deletedItems = 0
  let freedSpace = 0
  let error: string | undefined
  for (const tableName of tables) {
    const table = db.tables.find((t) => t.name === tableName)
    if (!table) continue
    try {
      const rows = await table.toArray()
      const idsToDelete: unknown[] = []
      for (const row of rows) {
        const completedAt = (row as { completedAt?: number }).completedAt
        const updatedAt = (row as { updatedAt?: number }).updatedAt
        const ts =
          (typeof completedAt === "number" ? completedAt : undefined) ??
          (typeof updatedAt === "number" ? updatedAt : undefined)
        if (typeof olderThan === "number" && ts !== undefined && ts > olderThan) {
          continue
        }
        deletedItems += 1
        freedSpace += rowSize(row)
        const primaryKey =
          (row as { id?: unknown; sessionId?: unknown; path?: unknown }).id ??
          (row as { sessionId?: unknown }).sessionId ??
          (row as { path?: unknown }).path
        if (primaryKey != null) idsToDelete.push(primaryKey)
      }
      if (idsToDelete.length === 0) continue
      try {
        await (table as { bulkDelete: (ids: unknown[]) => Promise<unknown> }).bulkDelete(
          idsToDelete
        )
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }
  return { deletedItems, freedSpace, error }
}

export async function previewCleanup(opts: CleanupOptions = {}): Promise<CleanupResult> {
  const categories = opts.categories ?? selectableCategories()
  const result = emptyResult()
  for (const category of categories) {
    const detail = await categoryStats(category, opts.olderThan)
    if (detail.deletedItems === 0 && detail.freedSpace === 0) continue
    result.details.push(detail)
    result.deletedItems += detail.deletedItems
    result.freedSpace += detail.freedSpace
  }
  return result
}

export async function cleanupCategories(opts: CleanupOptions = {}): Promise<CleanupResult> {
  const categories = opts.categories ?? selectableCategories()
  const result = emptyResult()
  for (const category of categories) {
    const apply = await applyCategoryDelete(category, opts.olderThan)
    if (apply.error) result.errors.push(`${category}: ${apply.error}`)
    if (apply.deletedItems === 0 && apply.freedSpace === 0) continue
    result.details.push({
      category,
      deletedItems: apply.deletedItems,
      freedSpace: apply.freedSpace,
    })
    result.deletedItems += apply.deletedItems
    result.freedSpace += apply.freedSpace
  }
  return result
}

export async function clearCategory(category: StorageCategory): Promise<number> {
  const result = await cleanupCategories({ categories: [category] })
  return result.deletedItems
}

export async function quickCleanup(): Promise<CleanupResult> {
  // Wipe transient buckets only — never user-authored data.
  return cleanupCategories({ categories: ["ttsKey", "system", "other"] })
}

export async function deepCleanup(): Promise<CleanupResult> {
  // Drop messages older than `DEEP_CLEANUP_AGE_MS` and any backup-history rows
  // older than that window. Sessions / characters / skills are *not* touched —
  // user-authored content stays put.
  const cutoff = Date.now() - DEEP_CLEANUP_AGE_MS
  return cleanupCategories({
    categories: ["chat", "backupHistory", "system", "other"],
    olderThan: cutoff,
  })
}

/** Categories the dialog offers via the "Custom" tab. We hide `settings` and
 *  the seed-driven categories so users can't accidentally wipe their config. */
export function selectableCategories(): StorageCategory[] {
  return [
    "session",
    "chat",
    "skill",
    "team",
    "mcp",
    "preset",
    "canvas",
    "trustedWorkspace",
    "ttsKey",
    "backupHistory",
    "system",
    "other",
  ]
}

export const __TESTING__ = {
  DEEP_CLEANUP_AGE_MS,
  rowSize,
}
