/**
 * "Spent X of a typical Y" for a run still in progress (ADR-0232, phase 2).
 *
 * Compares what the run has spent so far with the estimate for runs like it.
 * Cost is the measure when both sides have one; tokens stand in when the
 * spend or the estimate cannot be priced. Above the estimate's P90 the run is
 * flagged as outside the usual range. That is a statement about history, not
 * a prediction: there is no remaining-cost model, and nothing here stops,
 * pauses or warns beyond the line itself.
 */

import type { SessionUsageRow } from "@/lib/db/session-usage"
import { effectiveCostUsdDetailed } from "@/lib/usage/session-analytics"

import type { RunEstimate } from "./estimate"

/** What a live run has used so far. `null` where the source cannot say. */
export interface RunSpend {
  /** Known spend in USD, from the ledger's frozen per-turn costs. */
  costUsd: number | null
  tokens: number | null
}

/**
 * Spend of a live run from its ledger rows. Cost is the frozen per-turn cost
 * the Usage tab shows; it is `null` as soon as one turn is unpriced, because a
 * partial dollar figure compared with a whole one would read as "under budget"
 * when it is not. Tokens are always summed.
 */
export function spendFromUsageRows(rows: readonly SessionUsageRow[]): RunSpend {
  if (rows.length === 0) return { costUsd: null, tokens: null }
  let cost = 0
  let priced = true
  let tokens = 0
  for (const row of rows) {
    const effective = effectiveCostUsdDetailed(row)
    if (effective.known) cost += effective.cost
    else priced = false
    tokens += row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens
  }
  return { costUsd: priced ? cost : null, tokens }
}

export interface RunProgressComparison {
  metric: "cost" | "tokens"
  spent: number
  /** The estimate's P50 for this kind of run. */
  typical: number
  /** The estimate's P90: past this, the run is outside the usual range. */
  high: number
  overRange: boolean
  confidence: RunEstimate["confidence"]
  sampleCount: number
}

/**
 * Compare a live run's spend with its estimate, or `null` when there is
 * nothing to compare (no estimate, or no measure both sides share).
 */
export function compareRunProgress(
  spend: RunSpend,
  estimate: RunEstimate | null
): RunProgressComparison | null {
  if (!estimate || estimate.confidence === "none") return null
  const pick = (): Pick<RunProgressComparison, "metric" | "spent" | "typical" | "high"> | null => {
    if (spend.costUsd !== null && estimate.costUsd) {
      return {
        metric: "cost",
        spent: spend.costUsd,
        typical: estimate.costUsd.p50,
        high: estimate.costUsd.p90,
      }
    }
    if (spend.tokens !== null && estimate.tokens) {
      return {
        metric: "tokens",
        spent: spend.tokens,
        typical: estimate.tokens.p50,
        high: estimate.tokens.p90,
      }
    }
    return null
  }
  const picked = pick()
  if (!picked) return null
  return {
    ...picked,
    overRange: picked.spent > picked.high,
    confidence: estimate.confidence,
    sampleCount: estimate.sampleCount,
  }
}
