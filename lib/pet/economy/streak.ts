// Daily-care streak math (pure). A streak counts consecutive LOCAL calendar
// days with at least one direct user interaction. The cached `PetStreak` on
// the profile is advanced by `applyPetEvent`; profiles that predate the cache
// are backfilled once from the (≤2000-row) activity ledger — a bounded full
// scan, deliberately index-free.

import { normalizeStreak, type PetStreak } from "@/types/pet"

/** Local calendar day key (YYYY-MM-DD) for an epoch-ms timestamp. */
export function localDayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** Local day key of the day before `dayKey`'s date. */
function previousDayKey(ts: number): string {
  const d = new Date(ts)
  d.setDate(d.getDate() - 1)
  return localDayKey(d.getTime())
}

/**
 * Advance the streak for a counted interaction at `now`:
 * same day → unchanged · yesterday → +1 · gap (or first ever) → reset to 1.
 */
export function advanceStreak(prev: PetStreak | undefined, now: number): PetStreak {
  const cur = normalizeStreak(prev)
  const today = localDayKey(now)
  if (cur.lastDay === today) return cur
  if (cur.lastDay === previousDayKey(now) && cur.days > 0) {
    return { days: cur.days + 1, lastDay: today }
  }
  return { days: 1, lastDay: today }
}

/** Coin multiplier tiers: 1 (<3d), 1.25 (≥3d), 1.5 (≥7d), 2 (≥30d). */
export function coinMultiplier(days: number): number {
  if (!Number.isFinite(days) || days < 3) return 1
  if (days >= 30) return 2
  if (days >= 7) return 1.5
  return 1.25
}

/**
 * Backfill a streak from ledger rows (any order) for profiles that predate the
 * cache. Only direct user interactions count. Walks backwards from the most
 * recent interaction day: the streak is the run of consecutive days ending at
 * that day (a streak whose last day is before yesterday will be reset by the
 * next `advanceStreak` anyway, so we keep its true length here).
 */
export function computeStreakFromLedger(
  rows: ReadonlyArray<{ kind: string; source: string; ts: number }>,
  interactionKinds: ReadonlySet<string>
): PetStreak {
  const days = new Set<string>()
  for (const row of rows) {
    if (row.source === "user" && interactionKinds.has(row.kind)) {
      days.add(localDayKey(row.ts))
    }
  }
  if (days.size === 0) return { days: 0, lastDay: null }
  const sorted = [...days].sort()
  const last = sorted[sorted.length - 1]
  let count = 1
  // Walk back day-by-day from the last counted day while each previous
  // calendar day is present.
  let cursor = new Date(`${last}T12:00:00`)
  for (;;) {
    cursor = new Date(cursor.getTime())
    cursor.setDate(cursor.getDate() - 1)
    if (!days.has(localDayKey(cursor.getTime()))) break
    count += 1
  }
  return { days: count, lastDay: last }
}
