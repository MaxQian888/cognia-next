"use client"

/**
 * One "who spent this" row: a label, its share of the scope, its money, and a
 * fill bar.
 *
 * Extracted from `usage-diagnostics-card`'s private `AttributionRow` because
 * the Usage dashboard needs exactly the same row for its per-surface
 * breakdown. The two would otherwise have been the same markup twice, and the
 * transcript card is the one that already got the hard parts right.
 *
 * 1. The share ranks by COST where cost is known and falls back to TOKENS where
 *    it is not. A free or local model can dominate the plan's token budget
 *    while contributing $0, and ranking it at "0%" hides the very thing the
 *    user opened the view to find.
 * 2. The money goes through {@link formatBucketCost}, so a bucket holding
 *    unpriced turns reads as a lower bound rather than as a settled total.
 * 3. The percentage counts up, and the count-up is gated on reduced motion.
 *
 * Presentational only. Every number arrives already computed, so this renders
 * identically from a frozen transcript snapshot and from a live Dexie query.
 */

import { useCountUp } from "@/hooks/usage/use-count-up"
import { QuotaBar } from "@/components/settings/subscription/quota-bar"
import { UNKNOWN_COST, formatBucketCost } from "@/lib/usage/session-analytics"
import type { LimitsMeterStatus } from "@/types/subscription"

export interface UsageAttributionRowProps {
  /** Stable id, used only to build the test id. */
  id: string
  label: string
  /** Share of the scope as whole percent, or `null` when it cannot be derived. */
  pct: number | null
  /** Bucket cost, rendered through {@link formatBucketCost}. */
  costUsd: number
  unpricedTurns: number
  turns: number
  /** Optional second line (turn / token counts), shown in denser modes. */
  detail?: string
  /** Reduced-motion flag from `useFlowMotion`, which disables the count-up. */
  reduce?: boolean
  /** Bar tint. Defaults to the neutral "ok" fill. Callers may flag hot rows. */
  status?: LimitsMeterStatus
  testidPrefix?: string
}

export function UsageAttributionRow({
  id,
  label,
  pct,
  costUsd,
  unpricedTurns,
  turns,
  detail,
  reduce = false,
  status = "ok",
  testidPrefix = "usage-attribution",
}: UsageAttributionRowProps) {
  const animated = Math.round(useCountUp(pct ?? 0, { disabled: reduce, durationMs: 400 }))

  return (
    <li className="space-y-1" data-testid={`${testidPrefix}-${id}`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
          {pct == null ? UNKNOWN_COST : `${animated}%`}
          {" · "}
          {formatBucketCost(costUsd, unpricedTurns, turns)}
        </span>
      </div>
      <QuotaBar pct={pct} status={status} label={label} className="h-1.5" />
      {detail ? <p className="text-[10px] text-muted-foreground">{detail}</p> : null}
    </li>
  )
}
