"use client"

// Live-query wrapper for the backupHistory table. Returns the newest-first
// rows reactively so the History panel updates the moment a new backup is
// recorded. Falls back to an empty array during SSR / first-render.

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import {
  appendBackupHistory,
  clearBackupHistory,
  deleteBackupHistory,
  getLatestSuccessful,
  type BackupHistoryRow,
  type BackupHistoryType,
} from "@/lib/db/backup-history"

interface Options {
  type?: BackupHistoryType
  successOnly?: boolean
  limit?: number
}

export function useBackupHistory(opts: Options = {}): BackupHistoryRow[] {
  const rows = useLiveQuery(async () => {
    const db = getDb()
    let coll = db.backupHistory.orderBy("completedAt").reverse()
    if (opts.type) coll = coll.filter((r) => r.type === opts.type)
    if (opts.successOnly) coll = coll.filter((r) => r.success === true)
    if (opts.limit && opts.limit > 0) coll = coll.limit(opts.limit)
    return coll.toArray()
  }, [opts.type, opts.successOnly, opts.limit])
  return rows ?? []
}

/** Live-queried newest successful row, or undefined when nothing has succeeded. */
export function useLatestSuccessfulBackup(): BackupHistoryRow | undefined {
  return useLiveQuery(() => getLatestSuccessful(), [])
}

export { appendBackupHistory, clearBackupHistory, deleteBackupHistory }
export type { BackupHistoryRow }
