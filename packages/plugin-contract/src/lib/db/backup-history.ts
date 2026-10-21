/**
 * The plugin contract's share of `lib/db/backup-history.ts`, which re-exports these.
 */
export type BackupHistoryType = "manual" | "scheduled" | "auto"

export type BackupHistoryEncryption = "none" | "auto-key" | "passphrase"

export type BackupPayloadKind = "data" | "subscription"

export interface BackupHistoryRow {
  id: string
  /** Epoch ms when the export wrote-or-failed. */
  completedAt: number
  type: BackupHistoryType
  success: boolean
  encryption: BackupHistoryEncryption
  /**
   * Which pipeline produced the row (additive 2026-06-07 — non-indexed, no
   * Dexie bump; old rows lack it and read as "data"). "subscription" rows are
   * the encrypted subscription-vault packages synced to WebDAV.
   */
  payloadKind?: BackupPayloadKind
  /** Explicit producer identity; legacy scheduled rows cannot establish cadence. */
  producer?: "interval" | "cron"
  /** Plaintext / encrypted file size on disk, when known. */
  sizeBytes?: number
  /** Filename of the saved file, free-form. */
  filename?: string
  /** When `success === false`, the human-readable error. */
  errorMessage?: string
  /**
   * Which destination this row describes (additive 2026-08-16 — non-indexed,
   * no Dexie bump; old rows lack it and read as "local"). One row per remote
   * leg when a scheduled backup fans out to `all`.
   */
  destination?: "local" | "webdav" | "github" | "googledrive" | "convex" | "all"
  /**
   * Provenance of the device that produced the snapshot (additive 2026-06 —
   * no Dexie index change; old rows simply lack it). Mirrors
   * `BackupManifestV3.device`.
   */
  deviceId?: string
  /** Friendly label ("Windows desktop"), never the raw user agent. */
  deviceLabel?: string
  /** Always 3 for now; kept for forward-compatibility logging. */
  schemaVersion: 3
}
