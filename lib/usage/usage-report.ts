/**
 * The `/usage` report — everything the in-transcript usage card renders,
 * derived in one pure pass so the command handler only does I/O.
 *
 * Two independent planes meet here and must not be conflated:
 *
 *  • **Plan quota** — what the provider says is left of the 5-hour / weekly
 *    windows. It comes from `resolveUsageWindows` (the free OAuth usage
 *    endpoint fused with passive rate-limit header samples) and is the same
 *    reading Settings → Subscription shows.
 *  • **Local spend** — what this install actually recorded, from `sessionUsage`
 *    rows. It explains *where* the quota went (which surface, which model) but
 *    is NOT the provider's accounting: a turn served by an API key, a different
 *    machine, or a non-Anthropic provider all land here without touching the
 *    Claude plan windows.
 *
 * Keeping them separate is the point. A card that adds them together, or that
 * presents local spend as "your plan usage", lies in both directions.
 *
 * Everything is side-effect-free and clock-injectable. The renderer lives in
 * `components/chat/message-parts/usage-diagnostics-card.tsx`.
 */

import {
  aggregateByModel,
  aggregateBySurface,
  analyzeUsageContributors,
  bucketTokens,
  effectiveCostUsdDetailed,
  filterByRange,
  type ModelUsageRow,
  type PricingResolver,
} from "@/lib/usage/session-analytics"
import { resolveModelPricingUsd } from "@/lib/usage/pricing"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type {
  UsageScopeKey,
  UsageScopeReport,
  UsageSpendTotals,
} from "@cognia/plugin-contract/lib/usage/usage-report"
export type {
  UsageNote,
  UsageNoteId,
  UsageScopeKey,
  UsageScopeReport,
  UsageSpendTotals,
} from "@cognia/plugin-contract/lib/usage/usage-report"

/** Ordered scopes, narrowest first — also the tab order in the card. */
export const USAGE_SCOPE_KEYS: readonly UsageScopeKey[] = ["session", "today", "week"]

const EMPTY_TOTALS: UsageSpendTotals = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  durationMs: 0,
  unpricedTurns: 0,
  cacheHitRate: null,
  sessions: 0,
}

/**
 * Sum one set of rows. `cacheHitRate` is cache reads over all prompt tokens
 * (fresh input + cache reads + cache writes) — the share of the prompt that did
 * not have to be re-read at full price.
 */
export function summarizeSpend(
  rows: readonly SessionUsageRow[],
  resolve: PricingResolver = resolveModelPricingUsd
): UsageSpendTotals {
  if (rows.length === 0) return { ...EMPTY_TOTALS }
  const sessions = new Set<string>()
  const totals: UsageSpendTotals = { ...EMPTY_TOTALS }
  for (const r of rows) {
    const cost = effectiveCostUsdDetailed(r, resolve)
    totals.turns += 1
    totals.inputTokens += r.inputTokens
    totals.outputTokens += r.outputTokens
    totals.cacheReadTokens += r.cacheReadTokens
    totals.cacheCreationTokens += r.cacheCreationTokens
    totals.reasoningTokens += r.reasoningTokens ?? 0
    totals.costUsd += cost.cost
    totals.durationMs += r.durationMs
    if (!cost.known) totals.unpricedTurns += 1
    sessions.add(r.sessionId)
  }
  const promptTokens = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens
  totals.cacheHitRate = promptTokens > 0 ? totals.cacheReadTokens / promptTokens : null
  totals.sessions = sessions.size
  return totals
}

/** Build one scope from its already-filtered rows. */
export function buildUsageScope(
  key: UsageScopeKey,
  rows: readonly SessionUsageRow[],
  resolve: PricingResolver = resolveModelPricingUsd
): UsageScopeReport {
  return {
    key,
    totals: summarizeSpend(rows, resolve),
    surfaces: aggregateBySurface(rows, resolve),
    models: aggregateByModel(rows, resolve),
    contributors: analyzeUsageContributors(rows, { resolve }).contributors,
  }
}

export interface BuildUsageScopesInput {
  /**
   * Every locally-recorded row in the widest calendar scope (7 local days).
   * Imported rows must already be excluded by the caller — they were paid on
   * another machine and counting them would inflate "what this install used".
   */
  rows: readonly SessionUsageRow[]
  /**
   * The active session's OWN rows, unbounded by the calendar window.
   *
   * A long-running chat can be older than seven days; deriving its tab from
   * `rows` made it report "no recorded turns" for a session the user is looking
   * at. The session scope is a conversation, not a date range, so it gets its
   * own read. Omitted (or empty) when there is no active session.
   */
  sessionRows?: readonly SessionUsageRow[]
  /** Active chat session, when there is one — scopes the `session` window. */
  sessionId?: string | null
  now?: number
  resolve?: PricingResolver
}

/**
 * Precompute every attribution scope. Scopes with no rows are still returned:
 * "you ran nothing today" is an answer, and dropping the tab would make the
 * card's shape depend on data the user cannot see.
 */
export function buildUsageScopes(input: BuildUsageScopesInput): UsageScopeReport[] {
  const {
    rows,
    sessionRows,
    sessionId = null,
    now = Date.now(),
    resolve = resolveModelPricingUsd,
  } = input
  // Prefer the caller's unbounded read; fall back to filtering the calendar
  // rows so a caller that has only those still gets a correct (if truncated)
  // session tab rather than an empty one.
  const forSession = sessionId ? (sessionRows ?? rows.filter((r) => r.sessionId === sessionId)) : []
  return [
    buildUsageScope("session", forSession, resolve),
    buildUsageScope("today", filterByRange(rows, 1, now), resolve),
    buildUsageScope("week", filterByRange(rows, 7, now), resolve),
  ]
}

/** Share of a scope's tokens (0–1) attributable to one bucket. */
export function shareOfTokens(
  bucket: Pick<
    ModelUsageRow,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"
  >,
  totals: UsageSpendTotals
): number | null {
  const all =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens
  if (all <= 0) return null
  return bucketTokens(bucket) / all
}

/** Share of a scope's cost (0–1) attributable to one bucket, or `null`. */
export function shareOfCost(
  bucket: Pick<ModelUsageRow, "costUsd">,
  totals: UsageSpendTotals
): number | null {
  if (totals.costUsd <= 0) return null
  return bucket.costUsd / totals.costUsd
}
