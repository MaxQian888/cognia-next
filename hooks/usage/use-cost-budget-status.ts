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
  hasAnyCostCeiling,
  projectBudgetTarget,
  projectHasCostCeiling,
  projectsWithCostCeiling,
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
  /** One verdict per configured scope: global, per provider, then per project. */
  verdicts: CostBudgetVerdict[]
  /** Most severe verdict, or `null` when no ceiling is configured. */
  worst: CostBudgetVerdict | null
  /** True while the spend query has not resolved yet. */
  loading: boolean
  /** True when at least one positive ceiling exists. */
  configured: boolean
}

const EMPTY: CostBudgetVerdict[] = []

export interface CostBudgetStatusOptions {
  /**
   * Narrow the read-out to one workspace's own ceilings (ADR-0204). Without it
   * every configured scope is evaluated, including each project with a ceiling.
   */
  projectId?: string
}

export function useCostBudgetStatus(options: CostBudgetStatusOptions = {}): CostBudgetStatus {
  const { projectId } = options
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
  const resolved = useMemo(() => policy ?? {}, [policy])
  // Only the projects that carry a ceiling are read; the key keeps the live
  // query stable while the policy object is replaced with an equal one.
  const projectKey = (projectId ? [projectId] : projectsWithCostCeiling(resolved).sort()).join(
    "\u0000"
  )
  const spend = useLiveQuery(
    () =>
      readCostBudgetSpend(
        // Anchored at local midnight (the window start), not the clock, so the
        // query key is stable; `now` only picks the day and month windows.
        parseLocalDay(dayKey).getTime(),
        projectKey ? projectKey.split("\u0000") : []
      ).catch(() => null),
    [dayKey, projectKey]
  )

  const verdicts = useMemo(() => {
    if (!spend) return EMPTY
    if (!projectId) return evaluateCostBudget(resolved, spend)
    const target = projectBudgetTarget(projectId)
    return evaluateCostBudget(resolved, spend, undefined, projectId).filter(
      (verdict) => verdict.target === target
    )
  }, [resolved, spend, projectId])

  return {
    policy: resolved,
    spend: spend ?? null,
    verdicts,
    worst: worstCostBudgetVerdict(verdicts),
    loading: spend === undefined,
    configured: projectId
      ? projectHasCostCeiling(resolved, projectId)
      : hasAnyCostCeiling(resolved),
  }
}
