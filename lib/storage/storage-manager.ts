// Aggregates per-table row counts + size estimates into a `StorageStats`
// payload, surfaces health rules ("you're over 90% — clean up"), and provides
// a cross-table wipe used by the Maintenance tab's "Delete all data" button.
//
// Adapted (and trimmed) from D:\Project\Cognia\lib\storage\storage-manager.ts.
// Cognia caches snapshots and tracks trend/quota history; cognia-next does
// neither — `getStats` is an on-demand walk of the Dexie schema.

import { getDb } from "@/lib/db/schema"
import { getNativeVectorStoreSize } from "@cognia/vector"
import {
  categoryForTable,
  CATEGORY_INFO,
  defaultDisplayName,
  tablesForCategory,
} from "./category-info"
import type {
  StorageCategory,
  StorageCategoryInfo,
  StorageHealth,
  StorageIssue,
  StorageQuotaSnapshot,
  StorageRecommendation,
  StorageStats,
} from "./types"

const HEALTH_WARNING_PERCENT = 75
const HEALTH_CRITICAL_PERCENT = 90

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

async function readQuota(): Promise<StorageQuotaSnapshot> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return { used: 0, quota: 0, usagePercent: 0 }
  }
  try {
    const est = await navigator.storage.estimate()
    const used = est.usage ?? 0
    const quota = est.quota ?? 0
    const usagePercent = quota > 0 ? Math.min(100, (used / quota) * 100) : 0
    return { used, quota, usagePercent }
  } catch {
    return { used: 0, quota: 0, usagePercent: 0 }
  }
}

function readLocalStorageBytes(): number {
  if (typeof localStorage === "undefined") return 0
  let total = 0
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key) continue
      const value = localStorage.getItem(key) ?? ""
      // UTF-16: each code unit is 2 bytes — matches Cognia's estimate.
      total += (key.length + value.length) * 2
    }
  } catch {
    // Some sandboxes throw on full localStorage iteration; fall through.
  }
  return total
}

function estimateRowSize(row: unknown): number {
  try {
    return JSON.stringify(row).length
  } catch {
    return 0
  }
}

async function buildBreakdown(): Promise<StorageCategoryInfo[]> {
  const db = getDb()
  const buckets = new Map<StorageCategory, StorageCategoryInfo>()

  // Seed every known category so the breakdown lists zero-row buckets too.
  for (const [key, descriptor] of Object.entries(CATEGORY_INFO)) {
    const category = key as StorageCategory
    buckets.set(category, {
      category,
      displayName: descriptor.defaultName,
      itemCount: 0,
      totalSize: 0,
      sources: tablesForCategory(
        category,
        db.tables.map((table) => table.name)
      ),
    })
  }

  for (const table of db.tables) {
    const category = categoryForTable(table.name)
    const bucket = buckets.get(category)
    if (!bucket) continue

    let count = 0
    let bytes = 0
    try {
      const rows = await table.toArray()
      count = rows.length
      bytes = rows.reduce<number>((sum, row) => sum + estimateRowSize(row), 0)
    } catch {
      // Skip tables we can't read — they'll just show 0 rather than crashing the panel.
    }

    bucket.itemCount += count
    bucket.totalSize += bytes
    if (!bucket.sources.includes(table.name)) {
      bucket.sources.push(table.name)
    }
  }

  return Array.from(buckets.values()).sort((a, b) => b.totalSize - a.totalSize)
}

function computeHealth(stats: StorageStats): StorageHealth {
  const issues: StorageIssue[] = []
  const recommendations: StorageRecommendation[] = []
  const usagePercent = stats.total.usagePercent

  let status: StorageHealth["status"] = "healthy"
  if (usagePercent >= HEALTH_CRITICAL_PERCENT) {
    status = "critical"
    issues.push({
      severity: "high",
      message: `Storage is ${usagePercent.toFixed(1)}% full`,
      suggestedAction: "Clear unused data or export and remove old conversations.",
    })
  } else if (usagePercent >= HEALTH_WARNING_PERCENT) {
    status = "warning"
    issues.push({
      severity: "medium",
      message: `Storage is ${usagePercent.toFixed(1)}% full`,
      suggestedAction: "Consider cleaning up older items soon.",
    })
  }

  // Recommend cleanup for the top non-system category over 5 MB.
  for (const cat of stats.byCategory) {
    if (cat.category === "settings" || cat.category === "system") continue
    if (cat.totalSize < 5 * 1024 * 1024) continue
    recommendations.push({
      action: `Clean up ${defaultDisplayName(cat.category).toLowerCase()}`,
      description: `${cat.itemCount} rows, ${formatBytes(cat.totalSize)}.`,
      category: cat.category,
      estimatedSavings: Math.floor(cat.totalSize * 0.5),
    })
    if (recommendations.length >= 3) break
  }

  return { status, usagePercent, issues, recommendations }
}

export class StorageManagerImpl {
  formatBytes = formatBytes

  async getStats(): Promise<StorageStats> {
    const [total, byCategory, vectorBytes] = await Promise.all([
      readQuota(),
      buildBreakdown(),
      getNativeVectorStoreSize(),
    ])
    const localStorageBytes = readLocalStorageBytes()
    // IDB usage excludes the native vector store — it lives in a separate
    // sqlite file in the Tauri data dir, not inside IndexedDB.
    const indexedDBBytes = byCategory.reduce<number>((sum, cat) => sum + cat.totalSize, 0)

    if (vectorBytes > 0) {
      const vectorBucket = byCategory.find((c) => c.category === "vector")
      if (vectorBucket) {
        vectorBucket.totalSize = vectorBytes
        vectorBucket.itemCount = 1
        vectorBucket.sources = ["vectors.sqlite"]
      } else {
        byCategory.push({
          category: "vector",
          displayName: defaultDisplayName("vector"),
          itemCount: 1,
          totalSize: vectorBytes,
          sources: ["vectors.sqlite"],
        })
      }
      byCategory.sort((a, b) => b.totalSize - a.totalSize)
    }

    return {
      total,
      byCategory,
      localStorage: { used: localStorageBytes },
      indexedDB: { used: indexedDBBytes },
      generatedAt: Date.now(),
    }
  }

  async getHealth(): Promise<StorageHealth> {
    const stats = await this.getStats()
    return computeHealth(stats)
  }

  async clearAllCogniaData(): Promise<void> {
    const db = getDb()
    await db.transaction("rw", db.tables, async () => {
      for (const table of db.tables) {
        try {
          await table.clear()
        } catch {
          // Continue with the remaining tables.
        }
      }
    })
  }
}

export const StorageManager = new StorageManagerImpl()

export const __TESTING__ = {
  HEALTH_WARNING_PERCENT,
  HEALTH_CRITICAL_PERCENT,
  formatBytes,
  readLocalStorageBytes,
  computeHealth,
}
