/**
 * The snooze durations offered anywhere a conversation can be snoozed: the
 * status chip, the triage pane, the row menu, the keyboard's `s` menu, the bulk
 * bar and the phone's action sheet. One table, so every surface offers the
 * same three and labels them from the same `inbox.lifecycle.snooze` keys.
 *
 * Lives in `lib/` (re-exported from `lifecycle-status-chip.tsx`, where it
 * started) so the shared option lists can import it without a component cycle.
 */

export type SnoozePresetKey = "1h" | "8h" | "24h"

export const SNOOZE_PRESETS: ReadonlyArray<{ key: SnoozePresetKey; ms: number }> = [
  { key: "1h", ms: 60 * 60 * 1000 },
  { key: "8h", ms: 8 * 60 * 60 * 1000 },
  { key: "24h", ms: 24 * 60 * 60 * 1000 },
]

/** Wall-clock end of a snooze started at `now`. */
export function snoozeUntilFor(key: SnoozePresetKey, now: number): number {
  const preset = SNOOZE_PRESETS.find((option) => option.key === key)
  if (!preset) throw new Error(`Unknown snooze preset: ${key}`)
  return now + preset.ms
}
