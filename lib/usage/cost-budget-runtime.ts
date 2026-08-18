/**
 * Host wiring for the USD cost budget.
 *
 * Three responsibilities, each of which the pure policy layer
 * (`lib/usage/cost-budget.ts`) and the governor deliberately do not have:
 *
 *  1. **Read the spend.** Day and month totals, global and per-provider, come
 *     from the durable `providerCostDaily` rollup — the same table the routing
 *     engine's `dailyCostBudget` reads, so the two can never disagree.
 *  2. **Announce thresholds.** 80% / 95% go through `lib/notifications/notify`
 *     (ADR-0042), deduped per scope per day so a long session does not emit the
 *     same warning on every turn.
 *  3. **Gate the overrun.** At 100% the send is BLOCKED and a HITL gate opens on
 *     the existing `lib/runtime/approval-bus` — same shape as the
 *     `agent-team-budget` gate, so the workspace's `<GateModalsHost>` renders it
 *     with no new UI. Approving grants exactly one override.
 */

import { localDayString, getCostRange } from "@/lib/db/provider-cost-daily"
import { notify } from "@/lib/notifications/runtime"
import { waitForDecision, type ApprovalKey } from "@/lib/runtime/approval-bus"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"

import {
  formatBudgetRatio,
  GLOBAL_BUDGET_TARGET,
  type CostBudgetSpend,
  type CostBudgetVerdict,
} from "./cost-budget"

/** Approval-bus scope for a cost-budget override. */
export const COST_BUDGET_APPROVAL_SCOPE = "cost-budget"

/** First day of the calendar month `now` falls in, as an ISO day string. */
export function monthStartDay(now: number = Date.now()): string {
  const day = localDayString(now)
  return `${day.slice(0, 7)}-01`
}

/**
 * Read today's and this month's spend from the durable rollup.
 *
 * One range query covers both windows — today is a subset of the month, so
 * issuing two reads would only add a chance for them to disagree.
 */
export async function readCostBudgetSpend(now: number = Date.now()): Promise<CostBudgetSpend> {
  const today = localDayString(now)
  const rows = await getCostRange(monthStartDay(now), today)
  const spend: CostBudgetSpend = {
    dayUsd: 0,
    monthUsd: 0,
    byProviderDayUsd: {},
    byProviderMonthUsd: {},
  }
  for (const row of rows) {
    const cost = Number.isFinite(row.totalCostUsd) ? row.totalCostUsd : 0
    spend.monthUsd += cost
    spend.byProviderMonthUsd![row.providerId] =
      (spend.byProviderMonthUsd![row.providerId] ?? 0) + cost
    if (row.day === today) {
      spend.dayUsd += cost
      spend.byProviderDayUsd![row.providerId] =
        (spend.byProviderDayUsd![row.providerId] ?? 0) + cost
    }
  }
  return spend
}

function scopeLabel(verdict: CostBudgetVerdict): string {
  const window = verdict.period === "day" ? "Daily" : "Monthly"
  return verdict.target === GLOBAL_BUDGET_TARGET
    ? `${window} budget`
    : `${window} budget for ${verdict.target}`
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/**
 * Announce one crossed threshold.
 *
 * Deduped on scope + level + day: the same 95% warning must not re-fire on
 * every subsequent turn of a long session, but it SHOULD fire again tomorrow
 * when the window rolls over.
 */
export async function notifyCostBudgetThreshold(
  verdict: CostBudgetVerdict,
  now: number = Date.now()
): Promise<void> {
  if (verdict.level === "ok") return
  const exceeded = verdict.level === "exceeded"
  await notify({
    source: "system",
    // `critical` bypasses DND and per-source mute — correct for a ceiling that
    // is now blocking work, wrong for an 80% heads-up.
    level: exceeded || verdict.level === "critical" ? "critical" : "warning",
    title: exceeded
      ? `${scopeLabel(verdict)} exhausted`
      : `${scopeLabel(verdict)} at ${formatBudgetRatio(verdict.ratio)}`,
    body: `${money(verdict.usedUsd)} of ${money(verdict.limitUsd)} used.`,
    dedupeKey: `cost-budget:${verdict.scopeKey}:${verdict.level}:${localDayString(now)}`,
    // An exhausted budget blocks work until a human answers, so it belongs on
    // the numeric badge rather than in ambient activity.
    directed: exceeded,
    icon: "wallet",
    href: "/observability",
  })
}

/** Approval key for one blocked scope. */
export function costBudgetApprovalKey(scopeKey: string): ApprovalKey {
  return { scope: COST_BUDGET_APPROVAL_SCOPE, id: scopeKey }
}

export interface CostBudgetOverrideResult {
  approved: boolean
  scopeKey: string
}

/**
 * Open the HITL gate for a blocked scope and wait for the answer.
 *
 * Returns `approved: false` on rejection AND on abort — a caller that gave up
 * waiting must not be told the spend was authorised.
 */
export async function requestCostBudgetOverride(
  verdict: CostBudgetVerdict,
  options: { runId?: string; signal?: AbortSignal } = {}
): Promise<CostBudgetOverrideResult> {
  const key = costBudgetApprovalKey(verdict.scopeKey)
  const gates = usePendingGatesStore.getState()
  gates.open({
    key,
    gateType: "budget",
    title: `${scopeLabel(verdict)} exhausted`,
    body: `${money(verdict.usedUsd)} of ${money(verdict.limitUsd)} used. Approve to allow one more request.`,
    runId: options.runId ?? verdict.scopeKey,
    teamId: "",
  })
  try {
    const decision = await waitForDecision(key, options.signal)
    return { approved: decision.outcome === "approve", scopeKey: verdict.scopeKey }
  } catch {
    // Aborted (turn cancelled, page closed) — never read as approval.
    return { approved: false, scopeKey: verdict.scopeKey }
  } finally {
    usePendingGatesStore.getState().close(key)
  }
}
