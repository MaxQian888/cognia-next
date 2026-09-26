/**
 * How a count badge spells its number: whole, never negative, and capped —
 * "99+" once it passes 99. One spelling for every badge in the app: the
 * conversation rows, the rail and nav pills, the More menu, the mobile tab
 * bar and the OS taskbar overlay (`lib/shell/taskbar-badge.ts`).
 */

/** Counts above this read as `"99+"`. */
export const BADGE_COUNT_CAP = 99

/** The label a count badge shows for `count`. */
export function formatBadgeCount(count: number): string {
  const whole = Math.max(0, Math.floor(count))
  return whole > BADGE_COUNT_CAP ? `${BADGE_COUNT_CAP}+` : String(whole)
}
