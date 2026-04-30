// Storage stats / health / cleanup contract types. The breakdown surface in
// `components/data/storage/*` reads this shape directly; the back-end is
// `lib/storage/storage-manager.ts`.
//
// Adapted from D:\Project\Cognia\lib\storage\types.ts. Cognia tracks 16
// categories spanning subsystems (`agent`, `media`, `workflow`, `vector`, …)
// that don't have backing Dexie tables in cognia-next. This file lists only
// the categories we can populate from the v11 schema.

/** Logical buckets we group Dexie tables into for the breakdown UI. */
export type StorageCategory =
  | "settings"
  | "session"
  | "chat"
  | "character"
  | "skill"
  | "team"
  | "mcp"
  | "preset"
  | "canvas"
  | "trustedWorkspace"
  | "ttsKey"
  | "backupHistory"
  | "system"
  | "other"

export interface StorageCategoryInfo {
  category: StorageCategory
  /** Human-readable label, resolved through i18n at render time. */
  displayName: string
  /** Number of rows aggregated across the underlying tables. */
  itemCount: number
  /** Estimated bytes via `JSON.stringify(row).length` summed across rows. */
  totalSize: number
  /** Names of the underlying Dexie tables (for tooltips / debug). */
  sources: string[]
}

export interface StorageQuotaSnapshot {
  /** Bytes currently used by the origin (navigator.storage.estimate().usage). */
  used: number
  /** Bytes the origin can grow to (navigator.storage.estimate().quota). */
  quota: number
  /** `used / quota * 100` clamped to [0, 100]. */
  usagePercent: number
}

export interface StorageStats {
  /** Total used / quota across all storage backends. */
  total: StorageQuotaSnapshot
  /** Per-category breakdown, sorted descending by `totalSize`. */
  byCategory: StorageCategoryInfo[]
  /** localStorage usage estimate (bytes) — chars * 2 since UTF-16. */
  localStorage: { used: number }
  /** IndexedDB usage estimate (bytes). Identical to `total.used` on browsers
   *  that scope quota to IDB; we surface it separately so the overview can
   *  display a dedicated tile. */
  indexedDB: { used: number }
  /** Generated-at timestamp, epoch ms. */
  generatedAt: number
}

export type StorageHealthStatus = "healthy" | "warning" | "critical"

export interface StorageIssue {
  severity: "low" | "medium" | "high"
  message: string
  suggestedAction?: string
}

export interface StorageRecommendation {
  action: string
  description: string
  /** Category to clear / hint label for the actionable button. */
  category?: StorageCategory
  /** Bytes the user could free if they take this action. */
  estimatedSavings: number
}

export interface StorageHealth {
  status: StorageHealthStatus
  /** `total.used / total.quota * 100` — convenience copy from stats. */
  usagePercent: number
  issues: StorageIssue[]
  recommendations: StorageRecommendation[]
}

export interface CleanupDetail {
  category: StorageCategory
  /** Rows actually deleted (or estimated for `previewCleanup`). */
  deletedItems: number
  /** Bytes freed (or estimated). */
  freedSpace: number
}

export interface CleanupResult {
  /** Total bytes freed across all categories. */
  freedSpace: number
  /** Total rows deleted across all categories. */
  deletedItems: number
  /** Per-category contribution. */
  details: CleanupDetail[]
  /** Errors collected during the run; empty when clean. */
  errors: string[]
}

export interface CleanupOptions {
  /** Restrict cleanup to these categories. Empty / undefined = all. */
  categories?: StorageCategory[]
  /** Only delete rows older than this epoch ms. */
  olderThan?: number
}

/** Backend identifier used by `LocalPersistenceVisibilityPanel`. */
export interface LocalPersistenceVisibilityProjection {
  /** "Web (Dexie)" / "Desktop (Dexie)" / "Desktop (SQLite)" — for display. */
  modeLabel: string
  /** Short backend slug, e.g. `web-dexie` or `desktop-dexie`. */
  activeBackendLabel: string
  /** True when a backend is in a known-bad state. */
  isDegraded: boolean
  /** One-line description shown under the mode label. */
  summary: string
  /** Optional warnings / status messages. */
  diagnosticMessages: string[]
  /** Per-domain mirror status (chat / settings / canvas / …). */
  mirroredDomains: Array<{
    id: string
    label: string
    status: "completed" | "pending" | "degraded" | "unavailable"
  }>
  /** "Reconciled (12 domains)" / "Reconciliation pending" — under domains. */
  reconciliationLabel: string
  /** Optional recovery note (e.g. after a failed import). */
  recovery?: {
    headline: string
    detail: string
    warnings: string[]
  } | null
}
