// Unattended WebDAV upload decision + trigger. Consumed by the mobile
// autosync provider (resume / network-recovery events) — desktop scheduled
// uploads keep piggybacking on the backup scheduler's 30-minute tick.
//
// The dirty check is a cheap proxy, not a full table diff: we compare the
// last upload stamp (`webdavSync.lastSyncAt`) against the freshest of
// `AppSettings.updatedAt` (bumped on every settings write, including
// companion-sync merges) and the newest successful backup-history row. That
// catches the common "used the app since the last upload" case without
// scanning Dexie; deep data-only changes that touch neither signal are
// swept up by the next minimum-interval upload anyway.

import { getLatestSuccessful } from "@/lib/db/backup-history"
import { getSettings } from "@/lib/db/settings"

import {
  getSyncPassphrase,
  hasSyncPassphrase,
  loadPersistedSyncPassphrase,
} from "./passphrase-cache"
import { runWebDavSyncNow } from "./sync-now"

/** Hard floor between unattended uploads — resume/online bursts must not
 * re-encrypt the full package every few seconds. */
export const MIN_AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000

export interface AutoUploadInputs {
  /** `webdavSync.enabled` */
  enabled: boolean
  /** Session cache holds a (possibly hydrated) passphrase. */
  hasPassphrase: boolean
  /** Epoch ms of the last successful upload, null when never uploaded. */
  lastSyncAtMs: number | null
  /** Epoch ms of the freshest local-change proxy, null when unknown. */
  lastLocalChangeAtMs: number | null
  nowMs: number
  minIntervalMs?: number
}

/** Pure decision: upload only when enabled + unlocked + interval elapsed +
 * (never uploaded, or local changes postdate the last upload). */
export function shouldAutoUpload(i: AutoUploadInputs): boolean {
  if (!i.enabled || !i.hasPassphrase) return false
  const min = i.minIntervalMs ?? MIN_AUTO_SYNC_INTERVAL_MS
  if (i.lastSyncAtMs === null) return true
  if (i.nowMs - i.lastSyncAtMs < min) return false
  if (i.lastLocalChangeAtMs === null) return false
  return i.lastLocalChangeAtMs > i.lastSyncAtMs
}

export type AutoUploadOutcome =
  | { ran: false; reason: "disabled" | "locked" | "fresh" }
  | { ran: true; ok: boolean; error?: string }

/**
 * Evaluate the dirty check and, when due, run the shared sync-now pipeline
 * with an "auto" history row. Hydrates the persisted passphrase first so a
 * cold app start can still upload unattended (opt-in). Never throws.
 */
export async function maybeAutoUploadNow(nowMs: number = Date.now()): Promise<AutoUploadOutcome> {
  try {
    const settings = await getSettings()
    const wd = settings.webdavSync
    if (wd?.enabled !== true) return { ran: false, reason: "disabled" }

    if (!hasSyncPassphrase()) await loadPersistedSyncPassphrase()
    if (!hasSyncPassphrase()) return { ran: false, reason: "locked" }

    const parsed = wd.lastSyncAt ? Date.parse(wd.lastSyncAt) : NaN
    const lastSyncAtMs = Number.isNaN(parsed) ? null : parsed

    const latest = await getLatestSuccessful()
    const changeProxy = Math.max(settings.updatedAt ?? 0, latest?.completedAt ?? 0)
    const lastLocalChangeAtMs = changeProxy > 0 ? changeProxy : null

    if (
      !shouldAutoUpload({
        enabled: true,
        hasPassphrase: true,
        lastSyncAtMs,
        lastLocalChangeAtMs,
        nowMs,
      })
    ) {
      return { ran: false, reason: "fresh" }
    }

    const result = await runWebDavSyncNow(getSyncPassphrase() ?? "", { historyType: "auto" })
    return result.ok ? { ran: true, ok: true } : { ran: true, ok: false, error: result.error }
  } catch (err) {
    return { ran: true, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
