// Per-app backup history. Records every successful (and failed) export so the
// user can see "yes, I do back up" at a glance and re-find a recent file.
//
// Capped at 50 newest rows — once the cap is reached, oldest rows are pruned
// transactionally on every write so the table never grows unbounded.

import { getDb } from "./schema"

const HISTORY_CAP = 50

export type BackupHistoryType = "manual" | "scheduled" | "auto"
export type BackupHistoryEncryption = "none" | "auto-key" | "passphrase"

export interface BackupHistoryRow {
  id: string
  /** Epoch ms when the export wrote-or-failed. */
  completedAt: number
  type: BackupHistoryType
  success: boolean
  encryption: BackupHistoryEncryption
  /** Plaintext / encrypted file size on disk, when known. */
  sizeBytes?: number
  /** Filename of the saved file, free-form. */
  filename?: string
  /** When `success === false`, the human-readable error. */
  errorMessage?: string
  /** Always 3 for now; kept for forward-compatibility logging. */
  schemaVersion: 3
}

function newId(): string {
  return "bh_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/** Append a row, then trim the table to the newest `HISTORY_CAP` entries. */
export async function appendBackupHistory(
  partial: Omit<BackupHistoryRow, "id" | "schemaVersion"> & { id?: string }
): Promise<BackupHistoryRow> {
  const db = getDb()
  const row: BackupHistoryRow = {
    id: partial.id ?? newId(),
    completedAt: partial.completedAt,
    type: partial.type,
    success: partial.success,
    encryption: partial.encryption,
    sizeBytes: partial.sizeBytes,
    filename: partial.filename,
    errorMessage: partial.errorMessage,
    schemaVersion: 3,
  }
  await db.transaction("rw", db.backupHistory, async () => {
    await db.backupHistory.put(row)
    await pruneOldest(HISTORY_CAP)
  })
  return row
}

/** Newest-first list of all rows, optionally filtered by type. */
export async function listBackupHistory(filter?: {
  type?: BackupHistoryType
  successOnly?: boolean
  limit?: number
}): Promise<BackupHistoryRow[]> {
  const db = getDb()
  let coll = db.backupHistory.orderBy("completedAt").reverse()
  if (filter?.type) {
    coll = coll.filter((r) => r.type === filter.type)
  }
  if (filter?.successOnly) {
    coll = coll.filter((r) => r.success === true)
  }
  if (filter?.limit && filter.limit > 0) {
    coll = coll.limit(filter.limit)
  }
  return coll.toArray()
}

/** Most-recent successful row, or undefined if no successful backup yet. */
export async function getLatestSuccessful(): Promise<BackupHistoryRow | undefined> {
  const rows = await listBackupHistory({ successOnly: true, limit: 1 })
  return rows[0]
}

export async function clearBackupHistory(): Promise<void> {
  await getDb().backupHistory.clear()
}

export async function deleteBackupHistory(id: string): Promise<void> {
  await getDb().backupHistory.delete(id)
}

/** Prune to the newest `keep` entries. Runs inside the caller's transaction. */
async function pruneOldest(keep: number): Promise<void> {
  const db = getDb()
  const total = await db.backupHistory.count()
  if (total <= keep) return
  const toRemove = total - keep
  const oldest = await db.backupHistory.orderBy("completedAt").limit(toRemove).primaryKeys()
  if (oldest.length > 0) {
    await db.backupHistory.bulkDelete(oldest as string[])
  }
}

export const __TESTING__ = { HISTORY_CAP, pruneOldest }
