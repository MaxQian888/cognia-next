/**
 * Where one conversation's money went, turn by turn, and how that conversation
 * compares with the rest of your recent ones.
 *
 * `lib/analysis/session-report.ts` already answers "how healthy was this
 * session" in aggregate. What it cannot show is the SHAPE of the spend: a chat
 * whose context crept from 20k to 300k tokens costs most in its last few turns,
 * and the aggregate hides that. The timeline here is the per-turn view every
 * LLM tracing tool leads with (Langfuse, the Claude Code `/context` read-out),
 * and the rank answers the question a bare dollar figure cannot: is this a lot
 * *for me*?
 *
 * Pure and Dexie-free, like the rest of `lib/usage/`. Every cost goes through
 * {@link effectiveCostUsdDetailed}, so the timeline sums to the same figure the
 * session's cost badge shows.
 */

import type { SessionUsageRow, UsageSurface } from "@/lib/db/session-usage"
import {
  effectiveCostUsdDetailed,
  type PricingResolver,
  type SessionUsageSummary,
} from "@/lib/usage/session-analytics"
import { resolveModelPricingUsd } from "@/lib/usage/pricing"
import { percentilesOf } from "@/lib/observability/percentiles"

/** One billed turn, in conversation order. */
export interface TurnCostPoint {
  /** 1-based position among this session's billed turns. */
  index: number
  /** Row key. For chat turns this is the assistant message id, so it can be jumped to. */
  messageId: string
  at: number
  model?: string
  surface: UsageSurface
  /** Effective cost; `0` with `costKnown: false` means "unknown", not free. */
  costUsd: number
  costKnown: boolean
  /**
   * Prompt the model had to read: the SDK's effective context figure when it
   * reported one, else fresh input plus both cache tiers.
   */
  contextTokens: number
  outputTokens: number
  durationMs: number
  /** Running total of KNOWN cost through this turn. */
  cumulativeCostUsd: number
}

/** Order a session's rows and annotate each with its cost and running total. */
export function buildTurnTimeline(
  rows: readonly SessionUsageRow[],
  resolve: PricingResolver = resolveModelPricingUsd
): TurnCostPoint[] {
  const ordered = [...rows].sort((a, b) => a.at - b.at || a.messageId.localeCompare(b.messageId))
  let running = 0
  return ordered.map((row, i) => {
    const cost = effectiveCostUsdDetailed(row, resolve)
    running += cost.cost
    return {
      index: i + 1,
      messageId: row.messageId,
      at: row.at,
      model: row.model,
      surface: row.surface ?? "chat",
      costUsd: cost.cost,
      costKnown: cost.known,
      contextTokens:
        row.contextInputTokens && row.contextInputTokens > 0
          ? row.contextInputTokens
          : row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens,
      outputTokens: row.outputTokens,
      durationMs: row.durationMs,
      cumulativeCostUsd: running,
    }
  })
}

/**
 * The most expensive priced turns, costliest first (ties: earlier turn).
 * Unpriced turns are left out rather than ranked as free.
 */
export function topCostlyTurns(points: readonly TurnCostPoint[], limit = 5): TurnCostPoint[] {
  return points
    .filter((p) => p.costKnown && p.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd || a.index - b.index)
    .slice(0, Math.max(0, limit))
}

/** Share of the session's known cost carried by its single priciest turn, 0–1. */
export function costConcentration(points: readonly TurnCostPoint[]): number | null {
  const total = points.reduce((sum, p) => sum + (p.costKnown ? p.costUsd : 0), 0)
  if (!(total > 0) || points.length < 2) return null
  const top = topCostlyTurns(points, 1)[0]
  return top ? top.costUsd / total : null
}

/** Ratio of the last turn's context to the first's, or `null` under two turns. */
export function contextGrowth(points: readonly TurnCostPoint[]): number | null {
  if (points.length < 2) return null
  const first = points[0].contextTokens
  const last = points[points.length - 1].contextTokens
  return first > 0 ? last / first : null
}

/** A context fall this large between consecutive turns reads as a reset, not noise. */
export const CONTEXT_DROP_FRACTION = 0.3

/**
 * Turns whose context is at least {@link CONTEXT_DROP_FRACTION} smaller than
 * the previous turn's: a compaction, a cleared history or a fresh branch. The
 * data cannot say which, so the chart marks the drop and names none of them.
 */
export function detectContextDrops(
  points: readonly TurnCostPoint[],
  minDrop: number = CONTEXT_DROP_FRACTION
): TurnCostPoint[] {
  const drops: TurnCostPoint[] = []
  for (let i = 1; i < points.length; i += 1) {
    const before = points[i - 1].contextTokens
    if (before > 0 && (before - points[i].contextTokens) / before >= minDrop) drops.push(points[i])
  }
  return drops
}

export interface SessionCostRank {
  /** Share of comparable sessions that cost LESS than this one, 0–100. */
  percentile: number
  /** Comparable sessions (fully priced, excluding this one). */
  peers: number
  /** Median cost of those peers. */
  medianUsd: number
}

/** Peer window for {@link rankSessionCost}: long enough for a sample, short enough to be "recent". */
export const SESSION_RANK_WINDOW_DAYS = 30

/** Fewest peers a rank is computed against; below this a percentile is noise. */
export const MIN_RANK_PEERS = 5

/**
 * Rank one session's cost against its peers. Only fully priced sessions take
 * part, on both sides: a lower-bound cost cannot be placed on a scale, and an
 * unpriced peer sitting at "$0" would drag every rank upward.
 */
export function rankSessionCost(
  target: Pick<SessionUsageSummary, "sessionId" | "costUsd" | "unpricedTurns" | "turns">,
  summaries: readonly SessionUsageSummary[],
  minPeers: number = MIN_RANK_PEERS
): SessionCostRank | null {
  if (target.turns === 0 || target.unpricedTurns > 0) return null
  const peers = summaries.filter(
    (s) => s.sessionId !== target.sessionId && s.turns > 0 && s.unpricedTurns === 0
  )
  if (peers.length < minPeers) return null
  const cheaper = peers.filter((s) => s.costUsd < target.costUsd).length
  const [medianUsd] = percentilesOf(
    peers.map((s) => s.costUsd),
    [0.5]
  )
  return {
    percentile: Math.round((cheaper / peers.length) * 100),
    peers: peers.length,
    medianUsd,
  }
}
