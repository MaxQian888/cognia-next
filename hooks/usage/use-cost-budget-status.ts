"use client"

/**
 * Live spend against the configured USD ceilings.
 *
 * `lib/usage/cost-budget.ts` documents that evaluating with no `providerId`
 * yields every configured scope, "which is what a dashboard wants". Until now
 * nothing asked: the ceilings were only ever evaluated inside the send gate, so
 * the person setting a limit could not see how close they were to it, and the
 * per-provider ceilings had no read-out at all.
 *
 * The spend read is a Dexie live query over the same `providerCostDaily` rollup
 * the gate reads, so the number here and the number that blocks a send can
 * never disagree. The day key (not the raw clock) is the dependency, so the
 * subscription is rebuilt exactly once per local midnight rather than on every
 * tick of the shared subscription ticker.
 */

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { useSettingsStore } from "@/stores/settings"
import { useSubscriptionNow } from "@/lib/subscription/core/now-ticker"
import { localDayString } from "@/lib/db/provider-cost-daily"
import { parseLocalDay } from "@/lib/usage/session-analytics"
import { readCostBudgetSpend } from "@/lib/usage/cost-budget-runtime"
import {
  evaluateCostBudget,
  worstCostBudgetVerdict,
  type CostBudgetPolicy,
  type CostBudgetSpend,
  type CostBudgetVerdict,
} from "@/lib/usage/cost-budget"

export interface CostBudgetStatus {
  /** The persisted policy, never undefined so callers can read it directly. */
  policy: CostBudgetPolicy
  /** Observed spend, or `null` until the first live-query result lands. */
  spend: CostBudgetSpend | null
  /** One verdict per configured scope, global first then per provider. */
  verdicts: CostBudgetVerdict[]
  /** Most severe verdict, or `null` when no ceiling is configured. */
  worst: CostBudgetVerdict | null
  /** True while the spend query has not resolved yet. */
  loading: boolean
  /** True when at least one positive ceiling exists. */
  configured: boolean
}

const EMPTY: CostBudgetVerdict[] = []

/**
 * Whether any positive ceiling exists. Derived from the POLICY, not from the
 * verdict list: verdicts are empty while the spend query is still in flight,
 * and a card that reads "no limit configured" for the first frame after every
 * mount is worse than one that renders nothing until it knows.
 */
function hasAnyCeiling(policy: CostBudgetPolicy): boolean {
  const positive = (value: number | undefined): boolean =>
    typeof value === "number" && Number.isFinite(value) && value > 0
  return (
    positive(policy.dailyUsd) ||
    positive(policy.monthlyUsd) ||
    Object.values(policy.perProviderDailyUsd ?? {}).some(positive) ||
    Object.values(policy.perProviderMonthlyUsd ?? {}).some(positive)
  )
}

export function useCostBudgetStatus(): CostBudgetStatus {
  const policy = useSettingsStore((s) => s.settings?.costBudget)
  // The shared ticker owns the clock. Reading `Date.now()` here would be an
  // impure render, and a cold ticker returning 0 is handled by falling back to
  // the mount anchor rather than to a fresh clock read.
  const ticked = useSubscriptionNow()
  const [mountedAt] = useState(() => Date.now())
  // Day granularity is all `readCostBudgetSpend` reads, so anchoring on local
  // midnight keeps the query key stable through the day and rebuilds the
  // subscription exactly once, at midnight.
  const dayKey = localDayString(ticked > 0 ? ticked : mountedAt)
  const spend = useLiveQuery(
    () => readCostBudgetSpend(parseLocalDay(dayKey).getTime()).catch(() => null),
    [dayKey]
  )

  const resolved = useMemo(() => policy ?? {}, [policy])
  const verdicts = useMemo(
    () => (spend ? evaluateCostBudget(resolved, spend) : EMPTY),
    [resolved, spend]
  )

  return {
    policy: resolved,
    spend: spend ?? null,
    verdicts,
    worst: worstCostBudgetVerdict(verdicts),
    loading: spend === undefined,
    configured: hasAnyCeiling(resolved),
  }
}
