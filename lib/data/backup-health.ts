// Pure backup-health classifier for the "我的" surface. No React, no Dexie,
// no `window` — runs inside component loaders and inside tests.
//
// The mobile Me page used to surface only `getLatestSuccessful()` as a bare
// relative timestamp, which hid two things: a *failed* most-recent attempt,
// and staleness past the user's reminder window. This helper folds the latest
// attempt + latest success + reminder setting into a single health verdict the
// tile can colour.

import { shouldShowReminder } from "@/lib/data/scheduler"

export type BackupHealthStatus = "never" | "ok" | "stale" | "failed"

export interface BackupHealthResult {
  status: BackupHealthStatus
  /** Epoch ms of the newest *successful* backup, or null when none succeeded. */
  lastSuccessAt: number | null
}

export interface ComputeBackupHealthArgs {
  /** Newest successful row (for the relative-time value). */
  latestSuccess?: { completedAt: number } | null
  /** Newest row of any outcome (drives the "failed" verdict). */
  latestAttempt?: { success: boolean; completedAt: number } | null
  /** `settings.backupReminderDays` — the staleness window. */
  reminderDays?: number
  now?: number
}

/**
 * Classify backup health, top-down precedence:
 *   1. newest attempt failed        → "failed" (still reports lastSuccessAt)
 *   2. no history at all            → "never"
 *   3. past the reminder window     → "stale"  (reuses shouldShowReminder)
 *   4. otherwise                    → "ok"
 *
 * `dismissedAt` is intentionally NOT passed to shouldShowReminder: the tile
 * reflects *true* health, independent of the banner's dismissal (dismissal
 * only silences the nudge banner, not the at-a-glance health colour).
 */
export function computeBackupHealth(args: ComputeBackupHealthArgs): BackupHealthResult {
  const { latestSuccess, latestAttempt, reminderDays, now = Date.now() } = args
  const lastSuccessAt = latestSuccess?.completedAt ?? null

  if (latestAttempt && latestAttempt.success === false) {
    return { status: "failed", lastSuccessAt }
  }
  if (!latestAttempt && !latestSuccess) {
    return { status: "never", lastSuccessAt: null }
  }
  if (
    shouldShowReminder({
      reminderDays,
      lastSuccessAt: lastSuccessAt ?? undefined,
      dismissedAt: undefined,
      now,
    })
  ) {
    return { status: "stale", lastSuccessAt }
  }
  return { status: "ok", lastSuccessAt }
}
