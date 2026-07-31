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

export interface RunBudgetGovernor {
  readonly rootRunId: string
  /** The underlying root guard (thresholds / escalation / extendLimit). */
  readonly guard: BudgetGuard
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

export function createRunBudgetGovernor(opts: BudgetGuardOptions): RunBudgetGovernor {
  const guard = createBudgetGuard(opts)
  const ledgers = new Map<string, ChildLedger>()

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
