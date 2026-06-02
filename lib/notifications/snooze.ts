// Snooze (ADR-0042, Linear/Novu model). Pure helpers: compute `snoozedUntil`,
// test whether a record is currently snoozed, and decide auto-wake when new
// activity arrives on the same `groupKey`.

import type { NotificationRecord, NotificationPreferences } from "@/types/notifications"

/** Common snooze presets (ms). */
export const SNOOZE_PRESETS_MS = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "3h": 3 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
} as const

export type SnoozePreset = keyof typeof SNOOZE_PRESETS_MS

/** Epoch-ms to snooze until, from a preset or explicit duration. */
export function snoozeUntil(now: number, durationMs: number): number {
  return now + Math.max(0, durationMs)
}

/** True when the record is snoozed and should be hidden from the active feed. */
export function isSnoozed(rec: Pick<NotificationRecord, "snoozedUntil">, now: number): boolean {
  return rec.snoozedUntil !== undefined && rec.snoozedUntil > now
}

/**
 * Should a snoozed record auto-wake because a new event arrived on its group?
 * Gated by the `snoozeAutoWakeOnActivity` preference. Returns the records that
 * should have `snoozedUntil` cleared.
 */
export function selectAutoWake(
  groupRecords: NotificationRecord[],
  now: number,
  prefs: Pick<NotificationPreferences, "snoozeAutoWakeOnActivity">
): NotificationRecord[] {
  if (!prefs.snoozeAutoWakeOnActivity) return []
  return groupRecords.filter((r) => isSnoozed(r, now))
}
