/**
 * The tenant level of the two-level budget (ADR-0188 D22): what the existing
 * cost-budget ceilings still allow. Every configured scope that applies to the
 * provider counts — daily and monthly, global and per-provider — and the
 * tightest one is the limit. No configured scope means no tenant limit.
 *
 * Spend is read from the durable rollup the budget gate already uses, so a
 * Router + Fusion run and an ordinary send see the same number.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import {
  evaluateCostBudget,
  type CostBudgetSpend,
  type CostBudgetVerdict,
} from "@/lib/usage/cost-budget"
import { readCostBudgetSpend } from "@/lib/usage/cost-budget-runtime"

export interface TenantLimit {
  /** Remaining microusd under the tightest applicable scope; null = no limit. */
  remainingMicrousd: number | null
  /** The scope that binds, for the grant dialog. */
  binding: CostBudgetVerdict | null
}

export async function tenantLimitFor(
  costBudget: AppSettings["costBudget"],
  providerId: string,
  readSpend: () => Promise<CostBudgetSpend> = () => readCostBudgetSpend()
): Promise<TenantLimit> {
  if (!costBudget) return { remainingMicrousd: null, binding: null }
  const probe = evaluateCostBudget(costBudget, { dayUsd: 0, monthUsd: 0 }, providerId)
  if (probe.length === 0) return { remainingMicrousd: null, binding: null }
  const verdicts = evaluateCostBudget(costBudget, await readSpend(), providerId)
  let binding: CostBudgetVerdict | null = null
  let remaining = Number.POSITIVE_INFINITY
  for (const verdict of verdicts) {
    const left = verdict.limitUsd - verdict.usedUsd
    if (left < remaining) {
      remaining = left
      binding = verdict
    }
  }
  return {
    // Floor: the tenant never gets a fraction of a microusd it does not have.
    // The epsilon only absorbs binary float noise ($1 − $0.90 = 0.0999…98),
    // which would otherwise take a whole microusd away.
    remainingMicrousd: Math.max(0, Math.floor(remaining * 1_000_000 + 1e-6)),
    binding,
  }
}

/**
 * The tenant limit of a run that may call several providers: the tightest
 * limit over every provider behind its roles (`providerId::modelId` ids).
 * Null when none of them has a configured scope.
 */
export async function tightestTenantLimit(
  costBudget: AppSettings["costBudget"],
  deploymentIds: readonly string[],
  readSpend: () => Promise<CostBudgetSpend> = () => readCostBudgetSpend()
): Promise<number | null> {
  const providers = [
    ...new Set(
      deploymentIds
        .map((id) => id.slice(0, Math.max(0, id.indexOf("::"))))
        .filter((providerId) => providerId.length > 0)
    ),
  ]
  let tightest: number | null = null
  for (const providerId of providers) {
    const limit = await tenantLimitFor(costBudget, providerId, readSpend)
    if (limit.remainingMicrousd === null) continue
    tightest =
      tightest === null ? limit.remainingMicrousd : Math.min(tightest, limit.remainingMicrousd)
  }
  return tightest
}
