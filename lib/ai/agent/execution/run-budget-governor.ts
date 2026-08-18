// RunBudgetGovernor (ADR-0090 Phase 7) — the ONE budget authority for a run
// tree.
//
// Built ON the existing team BudgetGuard (thresholds, escalation actions,
// HITL extend) rather than beside it: the governor owns the ROOT guard and
// hands each delegated child an `allocate(childRunId)` slice whose every
// add() flows into the same root accounting. Attempts, provider attempts and
// failures are counted per child so "root budget 统计所有 child run、attempt
// 与失败" is a query, not a hope. Duplicate accounting (plugin budget's
// internal ledger) is retired in favor of this.

import type { SubAgentTokenUsage } from "@/types/agent/sub-agent"

import {
  createBudgetGuard,
  type BudgetGuard,
  type BudgetGuardOptions,
} from "@/lib/ai/agent/team/budget-guard"
import {
  evaluateCostBudget,
  exceededScopes,
  worstCostBudgetVerdict,
  type CostBudgetLevel,
  type CostBudgetPolicy,
  type CostBudgetSpend,
  type CostBudgetVerdict,
} from "@/lib/usage/cost-budget"

export interface ChildBudgetAccount {
  readonly childRunId: string
  /** Record usage — draws down the ROOT guard and this child's ledger. */
  add(usage: SubAgentTokenUsage): void
  /** Record the start of an attempt (retry/failover accounting). */
  recordAttempt(): void
  /** Record a provider-level attempt (credential failover, retry-after). */
  recordProviderAttempt(): void
  /** Record a terminal failure of this child. */
  recordFailure(): void
  /** True when the ROOT budget is critical — callers refuse further spend. */
  isExhausted(): boolean
}

export interface ChildBudgetSnapshot {
  childRunId: string
  usedTokens: number
  attempts: number
  providerAttempts: number
  failures: number
}

/** Outcome of asking the governor whether a spend may proceed. */
export type CostGateDecision =
  | { allowed: true; verdict: CostBudgetVerdict | null }
  /** At least one scope is at or past its ceiling and has no override. */
  | { allowed: false; blockedBy: CostBudgetVerdict[] }

export interface CostBudgetThresholdEvent {
  verdict: CostBudgetVerdict
  /** The level that was just crossed. Never `"ok"`. */
  level: Exclude<CostBudgetLevel, "ok">
}

/**
 * USD spend authority for the run tree.
 *
 * ADR-0090 §8 names the governor the single spend authority, so this lives ON
 * it rather than beside it — a second accountant is exactly how the token guard
 * and the plugin ledger drifted apart before.
 */
export interface CostBudgetController {
  /** Record spend that already happened. Fires threshold events once per level. */
  add(input: { costUsd: number; providerId?: string }): void
  /** Replace the observed spend snapshot (e.g. after re-reading the rollup). */
  syncSpend(spend: CostBudgetSpend): void
  /** Every configured scope's current verdict. */
  verdicts(providerId?: string): CostBudgetVerdict[]
  /** The single most severe verdict, or `null` with nothing configured. */
  worst(providerId?: string): CostBudgetVerdict | null
  /**
   * Decide whether a prospective spend may proceed.
   *
   * A scope at 100% BLOCKS. That is the point: a warning that scrolls past is
   * how people discover a budget was exceeded by noticing the bill.
   */
  check(providerId?: string): CostGateDecision
  /**
   * Grant a ONE-SHOT override for a scope key.
   *
   * One-shot deliberately: an override that persisted would silently turn the
   * ceiling off, and the next overrun would be as invisible as before.
   */
  grantOverride(scopeKey: string): void
  /** Scope keys currently holding an unused override. */
  pendingOverrides(): string[]
}

export interface RunBudgetGovernor {
  readonly rootRunId: string
  /** The underlying root guard (thresholds / escalation / extendLimit). */
  readonly guard: BudgetGuard
  /** USD budget authority — day/month × global/per-provider, hard block at 100%. */
  readonly cost: CostBudgetController
  /**
   * Open (or reopen — idempotent per id) a child's account. Every child of
   * the run tree draws from the SAME root pool; there is no per-child cap
   * here — slicing policy stays with the dispatcher.
   */
  allocate(childRunId: string): ChildBudgetAccount
  /** Per-child ledger (allocation order). */
  children(): ChildBudgetSnapshot[]
  /** Root totals across every child plus direct root spend. */
  totals(): {
    usedTokens: number
    limit: number
    level: "ok" | "warning" | "critical"
    attempts: number
    providerAttempts: number
    failures: number
  }
}

interface ChildLedger {
  usedTokens: number
  attempts: number
  providerAttempts: number
  failures: number
}

export interface RunBudgetGovernorOptions extends BudgetGuardOptions {
  /** USD ceilings. Omitted or all-empty ⇒ the cost controller never blocks. */
  costPolicy?: CostBudgetPolicy
  /** Spend already observed when the run starts (read from the durable rollup). */
  costSpend?: CostBudgetSpend
  /**
   * Called once per scope per level as thresholds are crossed. The runtime
   * routes this to `lib/notifications/notify`; tests assert on it directly.
   */
  onCostThreshold?: (event: CostBudgetThresholdEvent) => void
}

const EMPTY_SPEND: CostBudgetSpend = { dayUsd: 0, monthUsd: 0 }

export function createRunBudgetGovernor(opts: RunBudgetGovernorOptions): RunBudgetGovernor {
  const guard = createBudgetGuard(opts)
  const ledgers = new Map<string, ChildLedger>()
  const cost = createCostBudgetController(opts)

  const ledgerFor = (childRunId: string): ChildLedger => {
    let ledger = ledgers.get(childRunId)
    if (!ledger) {
      ledger = { usedTokens: 0, attempts: 0, providerAttempts: 0, failures: 0 }
      ledgers.set(childRunId, ledger)
    }
    return ledger
  }

  return {
    rootRunId: opts.runId,
    guard,
    cost,
    allocate(childRunId) {
      const ledger = ledgerFor(childRunId)
      return {
        childRunId,
        add(usage) {
          const delta =
            usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
          ledger.usedTokens += delta
          guard.add(usage)
        },
        recordAttempt() {
          ledger.attempts += 1
        },
        recordProviderAttempt() {
          ledger.providerAttempts += 1
        },
        recordFailure() {
          ledger.failures += 1
        },
        isExhausted() {
          return guard.status().level === "critical"
        },
      }
    },
    children() {
      return [...ledgers.entries()].map(([childRunId, ledger]) => ({ childRunId, ...ledger }))
    },
    totals() {
      const status = guard.status()
      let attempts = 0
      let providerAttempts = 0
      let failures = 0
      for (const ledger of ledgers.values()) {
        attempts += ledger.attempts
        providerAttempts += ledger.providerAttempts
        failures += ledger.failures
      }
      return {
        usedTokens: status.used,
        limit: status.limit,
        level: status.level,
        attempts,
        providerAttempts,
        failures,
      }
    },
  }
}

/**
 * The USD controller.
 *
 * Spend is tracked as a SNAPSHOT plus in-run deltas rather than re-read from
 * Dexie on every call: the durable rollup is authoritative but asynchronous,
 * and a budget that only notices spend after the write lands would let a burst
 * of parallel turns sail past the ceiling. `syncSpend` reconciles the snapshot
 * whenever the caller has a fresh read.
 */
function createCostBudgetController(opts: RunBudgetGovernorOptions): CostBudgetController {
  const policy: CostBudgetPolicy = opts.costPolicy ?? {}
  let snapshot: CostBudgetSpend = normalizeSpend(opts.costSpend ?? EMPTY_SPEND)
  /** Highest level already announced per scope — thresholds fire once each. */
  const announced = new Map<string, CostBudgetLevel>()
  /** Scope keys holding an unused one-shot override. */
  const overrides = new Set<string>()

  const verdictsFor = (providerId?: string): CostBudgetVerdict[] =>
    evaluateCostBudget(policy, snapshot, providerId)

  const announce = (): void => {
    for (const verdict of verdictsFor()) {
      if (verdict.level === "ok") continue
      const previous = announced.get(verdict.scopeKey)
      if (previous === verdict.level) continue
      // A single expensive turn can jump straight from ok to exceeded; report
      // the level actually reached rather than replaying every step.
      announced.set(verdict.scopeKey, verdict.level)
      opts.onCostThreshold?.({ verdict, level: verdict.level })
    }
  }

  return {
    add({ costUsd, providerId }) {
      const delta = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0
      if (delta === 0) return
      snapshot = {
        dayUsd: snapshot.dayUsd + delta,
        monthUsd: snapshot.monthUsd + delta,
        byProviderDayUsd: bump(snapshot.byProviderDayUsd, providerId, delta),
        byProviderMonthUsd: bump(snapshot.byProviderMonthUsd, providerId, delta),
      }
      announce()
    },
    syncSpend(spend) {
      snapshot = normalizeSpend(spend)
      // A scope that fell back below a threshold (a new day, a raised ceiling)
      // must be able to announce it again.
      for (const verdict of verdictsFor()) {
        if (verdict.level === "ok") announced.delete(verdict.scopeKey)
      }
      announce()
    },
    verdicts: verdictsFor,
    worst: (providerId) => worstCostBudgetVerdict(verdictsFor(providerId)),
    check(providerId) {
      const verdicts = verdictsFor(providerId)
      const exceeded = exceededScopes(verdicts)
      if (exceeded.length === 0) {
        return { allowed: true, verdict: worstCostBudgetVerdict(verdicts) }
      }
      // Every blocking scope must be covered — an override for the daily cap
      // does not authorise blowing through the monthly one.
      const uncovered = exceeded.filter((verdict) => !overrides.has(verdict.scopeKey))
      if (uncovered.length > 0) return { allowed: false, blockedBy: uncovered }
      // Consume the overrides: one grant authorises one send.
      for (const verdict of exceeded) overrides.delete(verdict.scopeKey)
      return { allowed: true, verdict: worstCostBudgetVerdict(verdicts) }
    },
    grantOverride(scopeKey) {
      if (scopeKey) overrides.add(scopeKey)
    },
    pendingOverrides: () => [...overrides],
  }
}

function normalizeSpend(spend: CostBudgetSpend): CostBudgetSpend {
  return {
    dayUsd: positive(spend.dayUsd),
    monthUsd: positive(spend.monthUsd),
    byProviderDayUsd: { ...(spend.byProviderDayUsd ?? {}) },
    byProviderMonthUsd: { ...(spend.byProviderMonthUsd ?? {}) },
  }
}

function bump(
  map: Record<string, number> | undefined,
  providerId: string | undefined,
  delta: number
): Record<string, number> {
  const next = { ...(map ?? {}) }
  if (providerId) next[providerId] = (next[providerId] ?? 0) + delta
  return next
}

function positive(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}
