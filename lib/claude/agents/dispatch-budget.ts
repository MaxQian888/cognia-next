/**
 * Per-subtree token-budget guard for nested subagent dispatch (A6).
 *
 * Reuses the team `createBudgetGuard` accounting core (`add`/`status`) but keys
 * one guard per dispatch SUBTREE (the top-level dispatch's run id). Every nested
 * `dispatchSubagent` in that subtree shares the SAME guard instance (looked up
 * by `budgetRootRunId`) so parallel fan-out and deep chains all draw down one
 * pool. When `status().level === "critical"`, callers refuse to dispatch deeper.
 *
 * The team notifier/concurrency/model escalation machinery is irrelevant here,
 * so we pass a silent notifier and `onCritical: "notify"` (the no-op branch).
 */

import { createBudgetGuard, type BudgetGuard } from "@/lib/ai/agent/team/budget-guard"
import type { TeamNotifier } from "@/lib/ai/agent/team/team-notifier"

const SILENT_NOTIFIER: TeamNotifier = {
  notify: () => {},
  suspend: () => {},
  resume: () => {},
}

interface DispatchBudgetEntry {
  guard: BudgetGuard
  /** Resolved token limit; `0` means unlimited. */
  limit: number
}

const guards = new Map<string, DispatchBudgetEntry>()

/**
 * Get the shared guard for a subtree, creating it (with `limitTokens`) on first
 * use. `limitTokens <= 0` means unlimited — the guard never reports critical.
 */
export function getOrCreateDispatchBudget(rootRunId: string, limitTokens: number): BudgetGuard {
  const existing = guards.get(rootRunId)
  if (existing) return existing.guard
  const limit = Math.max(0, limitTokens)
  const guard = createBudgetGuard({
    runId: rootRunId,
    limit,
    onCritical: "notify",
    notifier: SILENT_NOTIFIER,
  })
  guards.set(rootRunId, { guard, limit })
  return guard
}

/** Read the existing guard for a subtree, or `undefined` if none was created. */
export function getDispatchBudget(rootRunId: string): BudgetGuard | undefined {
  return guards.get(rootRunId)?.guard
}

/** Drop a subtree's guard once the top-level dispatch finishes. */
export function releaseDispatchBudget(rootRunId: string): void {
  guards.delete(rootRunId)
}

/**
 * Whether a deeper/sibling dispatch should be refused because the subtree has
 * burned through its budget. Unlimited budgets (limit 0) never trip.
 *
 * This shared-pool critical gate is the enforceable budget mechanism: a single
 * run's tokens can't be pre-capped (the runner bounds turns, not tokens), but
 * once the subtree pool hits the critical threshold no further dispatch is
 * allowed — bounding total runaway spend across deep + parallel fan-out.
 */
export function isDispatchBudgetExhausted(rootRunId: string | undefined): boolean {
  if (!rootRunId) return false
  const entry = guards.get(rootRunId)
  if (!entry) return false
  return entry.guard.status().level === "critical"
}

/**
 * Whether a subtree runs under a FINITE token budget (`limit > 0`). Callers use
 * this to decide concurrency: a finite budget must serialize parallel fan-out so
 * each sibling sees the prior siblings' draw-down (the guard is a post-hoc
 * accumulator, so concurrent siblings would otherwise all clear the pre-spend
 * `isDispatchBudgetExhausted` gate and overshoot in one batch). An unlimited
 * budget has nothing to overshoot, so its fan-out stays fully parallel.
 */
export function isDispatchBudgetFinite(rootRunId: string | undefined): boolean {
  if (!rootRunId) return false
  const entry = guards.get(rootRunId)
  return entry ? entry.limit > 0 : false
}

/** Test-only: drop all guards. */
export function __clearAllDispatchBudgetsForTesting(): void {
  guards.clear()
}
