/**
 * Usage slice (ADR-0225 §7), derived from one 30-day `UsageGlanceSnapshotV1`.
 *
 * Today and the last 7 days come out of that projection's daily buckets rather
 * than two more queries: the panel reads one window and slices it. The
 * definitions are the usage glance's own (tokens are fresh input + output;
 * cost sums priced turns only), so the panel can never disagree with the tray
 * title or the Capacity Dock about the same window.
 */

import { localDay } from "@/lib/usage/session-analytics"
import type { UsageGlanceSnapshotV1 } from "@/lib/usage/usage-glance"
import type { GlanceUsageScope } from "@/types/glance/layout"

import type { GlanceUsageDay, GlanceUsageSlice, GlanceUsageTotals } from "./snapshot"

const MAX_PROVIDERS = 4

/** The last `count` local day keys ending today, oldest first. */
export function lastLocalDays(now: number, count: number): string[] {
  const today = new Date(now)
  const out: string[] = []
  for (let back = count - 1; back >= 0; back -= 1) {
    // Calendar arithmetic at local noon, never `now - n * 24h`: across a DST
    // change a day is 23 or 25 hours, and millisecond subtraction would skip
    // or repeat a key.
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 12)
    out.push(localDay(day.getTime()))
  }
  return out
}

function sum(days: readonly GlanceUsageDay[]): GlanceUsageTotals {
  return days.reduce(
    (acc, day) => ({
      tokens: acc.tokens + day.tokens,
      knownCostUsd: acc.knownCostUsd + day.knownCostUsd,
      turns: acc.turns + day.turns,
    }),
    { tokens: 0, knownCostUsd: 0, turns: 0 }
  )
}

export interface BuildUsageSliceInput {
  /** A 30-day projection, or null while the first read is in flight. */
  glance: UsageGlanceSnapshotV1 | null
  scope: GlanceUsageScope
  showSpend: boolean
  workspaceFiltered: boolean
  now: number
}

export function buildUsageSlice(input: BuildUsageSliceInput): GlanceUsageSlice {
  const { glance, now } = input
  const byDay = new Map((glance?.daily ?? []).map((bucket) => [bucket.day, bucket]))
  const dayOf = (day: string): GlanceUsageDay => {
    const bucket = byDay.get(day)
    return {
      day,
      tokens: bucket?.tokens ?? 0,
      knownCostUsd: bucket?.knownCostUsd ?? 0,
      turns: bucket?.turns ?? 0,
    }
  }
  const week = lastLocalDays(now, 7).map(dayOf)
  const today = week[week.length - 1]

  const providerTokens = (glance?.topProviders ?? []).reduce((acc, p) => acc + p.tokens, 0)
  const top = glance?.topModels[0]

  return {
    updatedAt: glance?.generatedAt ?? now,
    scope: input.scope,
    showSpend: input.showSpend,
    workspaceFiltered: input.workspaceFiltered,
    freshness: glance?.freshness ?? "fresh",
    today: { tokens: today.tokens, knownCostUsd: today.knownCostUsd, turns: today.turns },
    week: sum(week),
    month: {
      tokens: glance?.billableTokens ?? 0,
      knownCostUsd: glance?.knownCostUsd ?? 0,
      turns: glance?.turns ?? 0,
    },
    unpricedTurns: glance?.unpricedTurns ?? 0,
    sparkline: week,
    topModel: top ? { id: top.id, tokens: top.tokens, knownCostUsd: top.knownCostUsd } : null,
    providers: (glance?.topProviders ?? []).slice(0, MAX_PROVIDERS).map((p) => ({
      id: p.id,
      tokens: p.tokens,
      knownCostUsd: p.knownCostUsd,
      share: providerTokens > 0 ? p.tokens / providerTokens : 0,
    })),
    budget:
      glance?.budget && glance.budget.ratio != null
        ? {
            ratio: glance.budget.ratio,
            period: glance.budget.period,
            blocked: glance.budget.blocked,
          }
        : null,
  }
}
