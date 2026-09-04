// Category-scoped cleanup operations. The Maintenance tab's
// `StorageCleanupDialog` calls these to free space without nuking everything
// (use `StorageManager.clearAllCogniaData()` for that).
//
// Three flavors:
//   - cleanupCategories: targeted, deletes the user-selected buckets.
//   - quickCleanup: wipes catalog-declared cache/projection rows.
//   - deepCleanup: additionally removes catalog-declared audit/queue rows that
//     have a recognized lifecycle timestamp older than seven days.
//
// `previewCleanup` runs the same accounting without writing, so the dialog
// can show "this will free ~X MB" before the user commits.

import { getDb } from "@/lib/db/schema"
import { policyForTable, type DataCleanupPolicy } from "@/lib/data-governance/table-catalog"
import { tablesForCategory } from "./category-info"
import type { CleanupDetail, CleanupOptions, CleanupResult, StorageCategory } from "./types"

const DEEP_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Estimate per-row byte cost; identical to the storage-manager helper. */
function rowSize(row: unknown): number {
  // A row that declares its own footprint is telling the truth about bytes
  // JSON cannot see. `JSON.stringify` turns a Blob into `{}`, so a 25 MiB
  // sprite atlas measured this way reported about two bytes, and the largest
  // thing on disk was the one the breakdown claimed was empty.
  if (row && typeof row === "object" && "totalBytes" in row) {
    const declared = (row as { totalBytes?: unknown }).totalBytes
    if (typeof declared === "number" && Number.isFinite(declared) && declared >= 0) {
      return declared
    }
  }
  try {
    return JSON.stringify(row).length
  } catch {
    return 0
  }
}

function emptyResult(): CleanupResult {
  return { freedSpace: 0, deletedItems: 0, details: [], errors: [] }
}

const RETENTION_TIMESTAMP_FIELDS = [
  "completedAt",
  "updatedAt",
  "createdAt",
  "timestamp",
  "ts",
  "startTime",
  "queuedAt",
  "occurredAt",
  "recordedAt",
] as const

function retentionTimestamp(row: unknown): number | undefined {
  if (!row || typeof row !== "object") return undefined
  const record = row as Record<string, unknown>
  for (const field of RETENTION_TIMESTAMP_FIELDS) {
    const value = record[field]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function isEligibleForCleanup(row: unknown, olderThan?: number): boolean {
  if (typeof olderThan !== "number") return true
  const timestamp = retentionTimestamp(row)
  // A deep cleanup must fail closed when a governed table has no recognized
  // lifecycle timestamp. Deleting undated rows would turn a missing policy
  // adapter into an unbounded purge.
  return timestamp !== undefined && timestamp <= olderThan
}

async function categoryStats(
  category: StorageCategory,
  olderThan?: number,
  allowedPolicies?: ReadonlySet<DataCleanupPolicy>
): Promise<CleanupDetail> {
  const db = getDb()
  const tables = cleanupTableNames(
    category,
    db.tables.map((table) => table.name),
    allowedPolicies
  )
  let deletedItems = 0
  let freedSpace = 0
  for (const tableName of tables) {
    const table = db.tables.find((t) => t.name === tableName)
    if (!table) continue
    try {
      const rows = await table.toArray()
      for (const row of rows) {
        if (!isEligibleForCleanup(row, olderThan)) continue
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
  olderThan?: number,
  allowedPolicies?: ReadonlySet<DataCleanupPolicy>
): Promise<{ deletedItems: number; freedSpace: number; error?: string }> {
  const db = getDb()
  const tables = cleanupTableNames(
    category,
    db.tables.map((table) => table.name),
    allowedPolicies
  )
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
        if (!isEligibleForCleanup(row, olderThan)) continue
        deletedItems += 1
        freedSpace += rowSize(row)
        const keyPath = table.schema.primKey.keyPath
        const primaryKey = Array.isArray(keyPath)
          ? keyPath.map((key) => (row as Record<string, unknown>)[key])
          : typeof keyPath === "string"
            ? (row as Record<string, unknown>)[keyPath]
            : undefined
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

function cleanupTableNames(
  category: StorageCategory,
  runtimeTableNames: readonly string[],
  allowedPolicies?: ReadonlySet<DataCleanupPolicy>
): string[] {
  const tableNames = tablesForCategory(category, runtimeTableNames)
  if (!allowedPolicies && category !== "other") return tableNames
  const policies = allowedPolicies ?? new Set<DataCleanupPolicy>(["quick", "deep"])
  return tableNames.filter((name) => {
    const policy = policyForTable(name)
    return policy !== undefined && policies.has(policy.cleanupPolicy)
  })
}

async function previewCleanupWithPolicies(
  opts: CleanupOptions,
  allowedPolicies?: ReadonlySet<DataCleanupPolicy>
): Promise<CleanupResult> {
  const categories = opts.categories ?? selectableCategories()
  const result = emptyResult()
  for (const category of categories) {
    const detail = await categoryStats(category, opts.olderThan, allowedPolicies)
    if (detail.deletedItems === 0 && detail.freedSpace === 0) continue
    result.details.push(detail)
    result.deletedItems += detail.deletedItems
    result.freedSpace += detail.freedSpace
  }
  return result
}

export async function previewCleanup(opts: CleanupOptions = {}): Promise<CleanupResult> {
  return previewCleanupWithPolicies(opts)
}

async function cleanupCategoriesWithPolicies(
  opts: CleanupOptions,
  allowedPolicies?: ReadonlySet<DataCleanupPolicy>
): Promise<CleanupResult> {
  const categories = opts.categories ?? selectableCategories()
  const result = emptyResult()
  for (const category of categories) {
    const apply = await applyCategoryDelete(category, opts.olderThan, allowedPolicies)
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

export async function cleanupCategories(opts: CleanupOptions = {}): Promise<CleanupResult> {
  return cleanupCategoriesWithPolicies(opts)
}

export async function clearCategory(category: StorageCategory): Promise<number> {
  const result = await cleanupCategories({ categories: [category] })
  return result.deletedItems
}

export async function quickCleanup(): Promise<CleanupResult> {
  // Wipe transient buckets only — never user-authored data.
  return cleanupCategoriesWithPolicies(
    { categories: ["ttsKey", "system", "other"] },
    new Set<DataCleanupPolicy>(["quick"])
  )
}

export async function deepCleanup(): Promise<CleanupResult> {
  // Authoritative rows remain protected; a missing timestamp also fails closed.
  const cutoff = Date.now() - DEEP_CLEANUP_AGE_MS
  return cleanupCategoriesWithPolicies(
    {
      categories: ["chat", "backupHistory", "system", "other"],
      olderThan: cutoff,
    },
    new Set<DataCleanupPolicy>(["quick", "deep"])
  )
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
  retentionTimestamp,
  isEligibleForCleanup,
  cleanupTableNames,
}
