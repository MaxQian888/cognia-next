// Pure helpers for the scheduled-backup feature. No React, no Dexie, no
// `window` — these run inside the provider's interval and inside tests.

import type { BackupAutoSchedule } from "@cognia/agent-config-types"

/**
 * Decide whether the auto-scheduler should fire a backup right now.
 *
 *   • config disabled → false
 *   • no successful row → true (first run)
 *   • last success older than `intervalDays` → true
 */
export function shouldRunScheduledBackup(args: {
  config: BackupAutoSchedule | undefined
  lastSuccessAt: number | undefined
  now?: number
}): boolean {
  const { config, lastSuccessAt, now = Date.now() } = args
  if (!config?.enabled) return false
  if (config.intervalDays <= 0) return false
  if (!lastSuccessAt) return true
  const ageMs = now - lastSuccessAt
  const intervalMs = config.intervalDays * 24 * 60 * 60 * 1000
  return ageMs >= intervalMs
}

/**
 * Decide whether the reminder banner should appear. Independent from the
 * auto-schedule path — even users who have automation off can opt into a
 * gentle "back up your data" nudge.
 *
 *   • reminderDays falsy → false (opt-out)
 *   • last successful backup younger than reminderDays → false
 *   • dismissed within the last reminderDays → false
 */
export function shouldShowReminder(args: {
  reminderDays: number | undefined
  lastSuccessAt: number | undefined
  dismissedAt: number | undefined
  now?: number
}): boolean {
  const { reminderDays, lastSuccessAt, dismissedAt, now = Date.now() } = args
  if (!reminderDays || reminderDays <= 0) return false
  const windowMs = reminderDays * 24 * 60 * 60 * 1000
  if (lastSuccessAt && now - lastSuccessAt < windowMs) return false
  if (dismissedAt && now - dismissedAt < windowMs) return false
  return true
}

export interface BackupCandidate {
  /** Filename or absolute path. */
  name: string
  /** Mtime / completedAt — newer is "younger". */
  completedAt: number
}

/**
 * Pick the candidates to delete so the scheduled-backup directory keeps only
 * the newest `retainCount` entries. Pure: takes the file list, returns the
 * subset to remove.
 */
export function pruneScheduledBackups<T extends BackupCandidate>(
  candidates: T[],
  retainCount: number
): T[] {
  if (retainCount <= 0) return [...candidates]
  if (candidates.length <= retainCount) return []
  const sorted = [...candidates].sort((a, b) => b.completedAt - a.completedAt)
  return sorted.slice(retainCount)
}
