/**
 * The production entry point for the USD cost budget.
 *
 * One call, made before a turn spends anything:
 *
 *   const decision = await enforceCostBudget({ providerId, runId, signal })
 *   if (!decision.allowed) return    // the user declined the overrun
 *
 * It reads the ceilings from settings, reads the spend from the durable
 * rollup, announces any newly-crossed threshold, and — at 100% — blocks until
 * a human approves exactly one more request.
 *
 * ## Why blocking, when the routing budget only warns
 *
 * `ProviderConstraint.dailyCostBudget` is advisory by design: it deprioritises
 * an over-budget provider and, if it was the only candidate, shows a toast and
 * proceeds. That is the right behaviour for a routing PREFERENCE. It is the
 * wrong behaviour for a spending LIMIT — a warning that scrolls past is how
 * people discover a budget was exceeded by reading the invoice. The two coexist:
 * routing still steers, this still stops.
 */

import type { AppSettings } from "@cognia/agent-config-types"

import { useSettingsStore } from "@/stores/settings"

import {
  evaluateCostBudget,
  exceededScopes,
  worstCostBudgetVerdict,
  type CostBudgetLevel,
  type CostBudgetPolicy,
  type CostBudgetVerdict,
} from "./cost-budget"
import {
  notifyCostBudgetThreshold,
  readCostBudgetSpend,
  requestCostBudgetOverride,
} from "./cost-budget-runtime"

export interface EnforceCostBudgetInput {
  /** Provider about to be charged. Scopes the per-provider ceilings. */
  providerId?: string
  /** Run this send belongs to — labels the HITL gate. */
  runId?: string
  signal?: AbortSignal
  /** Injected for tests; defaults to the persisted settings singleton. */
  loadSettings?: () => Promise<AppSettings | undefined>
  now?: number
}

export interface CostBudgetGateResult {
  allowed: boolean
  /** The most severe scope evaluated, or `null` when no ceiling is configured. */
  verdict: CostBudgetVerdict | null
  /** Scopes that blocked, when `allowed` is false. */
  blockedBy: CostBudgetVerdict[]
}

const ALLOW_UNCONFIGURED: CostBudgetGateResult = { allowed: true, verdict: null, blockedBy: [] }

/** Highest level already announced per scope, per process. */
const announced = new Map<string, CostBudgetLevel>()

/** Test-only: forget which thresholds have been announced. */
export function __resetCostBudgetGateForTesting(): void {
  announced.clear()
}

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

/**
 * Synchronous pre-check: is any ceiling configured at all?
 *
 * The send path calls this FIRST so the default install — which configures no
 * budget — pays nothing for the feature. `enforceCostBudget` is async, and
 * awaiting it unconditionally would add a hop to every turn purely to discover
 * there is no limit to check. Reads the hydrated settings store, not Dexie, for
 * the same reason.
 */
export function isCostBudgetConfigured(): boolean {
  try {
    const settings = useSettingsStore.getState().settings
    return hasAnyCeiling(settings?.costBudget ?? {})
  } catch {
    return false
  }
}

async function defaultLoadSettings(): Promise<AppSettings | undefined> {
  const { getSettings } = await import("@/lib/db/settings")
  return getSettings()
}

/**
 * Evaluate the budget for one prospective send.
 *
 * Fails OPEN on any infrastructure error. A budget that blocks work because
 * Dexie hiccuped is worse than one that misses a single overrun: the user did
 * not ask for their app to stop, they asked for it not to overspend, and the
 * next send re-evaluates against a rollup that includes this one.
 */
export async function enforceCostBudget(
  input: EnforceCostBudgetInput = {}
): Promise<CostBudgetGateResult> {
  let policy: CostBudgetPolicy
  try {
    const settings = await (input.loadSettings ?? defaultLoadSettings)()
    policy = settings?.costBudget ?? {}
  } catch {
    return ALLOW_UNCONFIGURED
  }
  if (!hasAnyCeiling(policy)) return ALLOW_UNCONFIGURED

  let verdicts: CostBudgetVerdict[]
  try {
    const spend = await readCostBudgetSpend(input.now)
    verdicts = evaluateCostBudget(policy, spend, input.providerId)
  } catch {
    return ALLOW_UNCONFIGURED
  }

  await announceThresholds(verdicts, input.now)

  const blocking = exceededScopes(verdicts)
  const worst = worstCostBudgetVerdict(verdicts)
  if (blocking.length === 0) return { allowed: true, verdict: worst, blockedBy: [] }

  // Every blocking scope needs its own answer: approving the daily overrun does
  // not authorise blowing through the monthly one.
  for (const verdict of blocking) {
    const decision = await requestCostBudgetOverride(verdict, {
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (!decision.approved) return { allowed: false, verdict: worst, blockedBy: blocking }
  }
  return { allowed: true, verdict: worst, blockedBy: [] }
}

/** Notify once per scope per level; re-arm when a scope falls back to ok. */
async function announceThresholds(
  verdicts: readonly CostBudgetVerdict[],
  now?: number
): Promise<void> {
  for (const verdict of verdicts) {
    if (verdict.level === "ok") {
      // A new day or a raised ceiling must be able to warn again.
      announced.delete(verdict.scopeKey)
      continue
    }
    if (announced.get(verdict.scopeKey) === verdict.level) continue
    announced.set(verdict.scopeKey, verdict.level)
    try {
      await notifyCostBudgetThreshold(verdict, now)
    } catch {
      // A failed notification must not block the send it was warning about.
    }
  }
}
