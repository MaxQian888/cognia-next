/**
 * Pure "activity" analytics over `sessionUsage` rows — the headline numbers the
 * chat welcome dashboard (`components/chat/welcome/welcome-stats.tsx`) shows.
 *
 * Nothing here re-derives a figure the Subscription → Usage tab already owns:
 * cost goes through {@link effectiveCostUsd}, the top model through
 * {@link topModelByTokens}, and every calendar bucket through the shared
 * {@link localDay}. That is deliberate — the welcome page and the usage tab read
 * the same table, so they must never disagree about "how many tokens" or "how
 * many active days" for the same window. The range filter is the tab's own
 * {@link filterByRange}, applied by the caller before the rows land here.
 *
 * Side-effect-free and clock-injectable, like the rest of `lib/usage/`.
 */

import type { SessionUsageRow } from "@/lib/db/session-usage"
import {
  effectiveCostUsd,
  localDay,
  parseLocalDay,
  topModelByTokens,
  type PricingResolver,
} from "@/lib/usage/session-analytics"
import { resolveModelPricingUsd } from "@/lib/usage/pricing"

/** Headline activity figures for one window of usage rows. */
export interface ActivityStats {
  /** Billable turns (rows) in range. */
  turns: number
  /** Distinct sessions represented — chat sessions, workflow runs, team runs. */
  sessions: number
  /** Input + output + cache-read tokens, matching `aggregateByDay`'s `tokens`. */
  totalTokens: number
  /** Summed {@link effectiveCostUsd} — SDK figure when present, else priced. */
  costUsd: number
  /** Summed SDK-reported generation time. 0 when no turn reported one. */
  durationMs: number
  /** Distinct LOCAL calendar days carrying at least one turn. */
  activeDays: number
  /**
   * Consecutive active days ending today — or ending yesterday when today has
   * no turns yet, so an unbroken streak doesn't read as 0 every morning.
   */
  currentStreak: number
  /** Longest run of consecutive active days anywhere in range. */
  longestStreak: number
  /** Local hour (0–23) with the most turns; `null` when there are none. Ties → earlier hour. */
  peakHour: number | null
  /** Model that moved the most tokens; `null` when there are no rows. */
  topModel: string | null
}

/** All-zero stats — the shape callers render before any usage exists. */
export const EMPTY_ACTIVITY_STATS: ActivityStats = {
  turns: 0,
  sessions: 0,
  totalTokens: 0,
  costUsd: 0,
  durationMs: 0,
  activeDays: 0,
  currentStreak: 0,
  longestStreak: 0,
  peakHour: null,
  topModel: null,
}

/**
 * The day key `delta` calendar days from `key`. Goes through `Date` arithmetic
 * rather than adding multiples of 86_400_000ms so DST transitions (23h / 25h
 * days) still step exactly one day, and month/year ends roll over.
 */
function shiftDayKey(key: string, delta: number): string {
  const d = parseLocalDay(key)
  d.setDate(d.getDate() + delta)
  return localDay(d.getTime())
}

const previousDayKey = (key: string) => shiftDayKey(key, -1)
const nextDayKey = (key: string) => shiftDayKey(key, 1)

/**
 * Longest run of consecutive days present in `active`, walking each day back to
 * its predecessor. O(n) over the set: a day whose predecessor is also active is
 * never a run start, so every day is visited at most twice.
 */
function longestRun(active: ReadonlySet<string>): number {
  let longest = 0
  for (const day of active) {
    if (active.has(previousDayKey(day))) continue // not the start of a run
    let run = 1
    let cursor = day
    for (;;) {
      const next = nextDayKey(cursor)
      if (!active.has(next)) break
      run += 1
      cursor = next
    }
    if (run > longest) longest = run
  }
  return longest
}

/**
 * Consecutive active days ending at `today`, with a one-day grace: a streak
 * that ran through yesterday is still "current" until today ends. Returns 0
 * when neither today nor yesterday carries a turn.
 */
function currentRun(active: ReadonlySet<string>, today: string): number {
  let cursor = active.has(today) ? today : previousDayKey(today)
  if (!active.has(cursor)) return 0
  let run = 0
  while (active.has(cursor)) {
    run += 1
    cursor = previousDayKey(cursor)
  }
  return run
}

/** Local hour with the most turns; ties resolve to the earlier hour. */
function busiestHour(rows: readonly SessionUsageRow[]): number | null {
  if (rows.length === 0) return null
  const buckets = new Array<number>(24).fill(0)
  for (const r of rows) buckets[new Date(r.at).getHours()] += 1
  let best = 0
  for (let h = 1; h < 24; h += 1) {
    if (buckets[h] > buckets[best]) best = h
  }
  return best
}

/**
 * Fold usage rows into the welcome dashboard's headline figures. Pass rows that
 * are already range-filtered (`filterByRange`) — the streaks and active-day
 * counts describe exactly the rows handed in.
 */
export function collectActivityStats(
  rows: readonly SessionUsageRow[],
  opts: { now?: number; resolve?: PricingResolver } = {}
): ActivityStats {
  if (rows.length === 0) return { ...EMPTY_ACTIVITY_STATS }

  const now = opts.now ?? Date.now()
  const resolve = opts.resolve ?? resolveModelPricingUsd

  let totalTokens = 0
  let costUsd = 0
  let durationMs = 0
  const sessions = new Set<string>()
  const days = new Set<string>()

  for (const r of rows) {
    totalTokens += r.inputTokens + r.outputTokens + r.cacheReadTokens
    costUsd += effectiveCostUsd(r, resolve)
    durationMs += r.durationMs
    sessions.add(r.sessionId)
    days.add(localDay(r.at))
  }

  return {
    turns: rows.length,
    sessions: sessions.size,
    totalTokens,
    costUsd,
    durationMs,
    activeDays: days.size,
    currentStreak: currentRun(days, localDay(now)),
    longestStreak: longestRun(days),
    peakHour: busiestHour(rows),
    topModel: topModelByTokens(rows, resolve),
  }
}
