/**
 * ADR-0020 W1 — audit retention sweeper.
 *
 * `lib/automation/audit.ts` enforces the 5000-row LRU cap inside Dexie,
 * but the operator-configurable `automationSettings.audit.retentionDays`
 * (default 30) was unconsumed pre-W1. This module honors that field
 * with two complementary actions:
 *
 * - `pruneAuditOlderThan(days)` — one-shot deletion of every row whose
 *   `ts` is older than `now() - days * 86400000`. Idempotent and safe
 *   to call from anywhere. Returns the number of rows removed so the
 *   diagnostics tab can show how aggressively retention is cutting.
 *
 * - `startAuditRetentionSweeper()` — boot-time wiring. Runs an initial
 *   prune, then schedules a fresh prune every 24h via `setInterval`.
 *   Returns an unsubscribe handle the caller can call on
 *   process / tab teardown. No-op in web mode (no Tauri settings to
 *   read), so the renderer-side React initializer doesn't have to gate
 *   on `isTauri()` itself.
 */

import { getDb } from "@/lib/db/schema"
import { isTauri } from "@/lib/tauri"
import { desktop, defaultAutomationSettings } from "@/lib/automation/client"

const MS_PER_DAY = 86_400_000
/** Re-sweep cadence — once per day matches the resolution of `retentionDays`. */
export const RETENTION_SWEEP_INTERVAL_MS = MS_PER_DAY

export type Unsubscribe = () => void

/**
 * Delete every audit row whose `ts` is older than `now() - days`. Returns
 * the count removed. `days <= 0` short-circuits without touching the
 * table — the operator using `0` means "keep everything", not "delete
 * everything". The LRU cap in `recordAuditRow` is the lower bound;
 * retention only ever shortens the visible window from the other end.
 */
export async function pruneAuditOlderThan(days: number): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) return 0
  const cutoff = Date.now() - days * MS_PER_DAY
  const db = getDb()
  // Pull keys first then delete in one pass — Dexie's
  // `where("ts").below(cutoff).delete()` is the obvious primitive, but
  // it doesn't return a count without an extra count() query, and we
  // want the count for diagnostics.
  const expiredKeys = await db.automationAuditLog.where("ts").below(cutoff).primaryKeys()
  if (expiredKeys.length === 0) return 0
  await db.automationAuditLog.bulkDelete(expiredKeys as string[])
  return expiredKeys.length
}

/**
 * Run an initial prune and schedule a recurring one every 24h. Returns
 * an `Unsubscribe` that cancels the timer. In web mode the settings
 * IPC is a stub; we still call `pruneAuditOlderThan` with the default
 * 30-day window so a single-mode dev session doesn't accumulate stale
 * audit rows indefinitely.
 */
export async function startAuditRetentionSweeper(): Promise<Unsubscribe> {
  // Pull the live `retentionDays` once at boot; subsequent sweeps
  // re-read in case the operator changed it through Settings →
  // Automation → Audit.
  await sweepOnce().catch((err) => console.warn("automation audit retention sweep failed", err))
  const id = setInterval(() => {
    void sweepOnce().catch((err) => console.warn("automation audit retention sweep failed", err))
  }, RETENTION_SWEEP_INTERVAL_MS)
  return () => clearInterval(id)
}

async function sweepOnce(): Promise<void> {
  const days = await readRetentionDays()
  await pruneAuditOlderThan(days)
}

async function readRetentionDays(): Promise<number> {
  if (!isTauri()) return defaultAutomationSettings().audit.retentionDays
  try {
    const settings = await desktop.settingsGet()
    return settings.audit?.retentionDays ?? defaultAutomationSettings().audit.retentionDays
  } catch {
    return defaultAutomationSettings().audit.retentionDays
  }
}
