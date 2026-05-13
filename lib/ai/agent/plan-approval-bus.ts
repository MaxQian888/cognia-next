/**
 * Plan-approval bus for the Agent Teams runtime.
 *
 * Thin wrapper around the generic `lib/runtime/approval-bus`. The agent-team
 * runtime suspends a team's lifecycle while a human reviews the lead's
 * proposed plan; this module preserves the legacy `teamId`-keyed API so
 * existing call sites and tests don't change, while the shared primitive
 * now also powers GitHub Delivery's HITL guard (and any future "wait for
 * a human decision" use case).
 *
 * Producers: the plan-approval UI calls `approve(teamId, plan)` /
 * `reject(teamId, feedback)`.
 *
 * Consumers: the runtime calls `waitForDecision(teamId, signal)` and
 * `await`s the returned promise.
 */

import {
  approve as genericApprove,
  pendingCount as genericPendingCount,
  reject as genericReject,
  waitForDecision as genericWaitForDecision,
  __resetForTesting as genericReset,
  type ApprovalDecision,
} from "@/lib/runtime/approval-bus"

const SCOPE = "agent-team"

/**
 * Decision payload — kept as a named export so existing code that imports
 * `PlanApprovalDecision` keeps compiling. Shape is identical to the
 * generic `ApprovalDecision`.
 */
export type PlanApprovalDecision = ApprovalDecision

/**
 * Wait for an approve or reject signal for `teamId`. Resolves with the
 * caller-supplied decision once `approve()` or `reject()` is called for
 * the same `teamId`. If `signal` aborts before either fires, the
 * promise rejects with the abort reason and the resolver is removed.
 */
export function waitForDecision(
  teamId: string,
  signal?: AbortSignal
): Promise<PlanApprovalDecision> {
  return genericWaitForDecision({ scope: SCOPE, id: teamId }, signal)
}

/** Notify every waiter for `teamId` that the plan was approved. */
export function approve(teamId: string, plan?: unknown): number {
  return genericApprove({ scope: SCOPE, id: teamId }, plan)
}

/** Notify every waiter for `teamId` that the plan was rejected. */
export function reject(teamId: string, feedback?: string): number {
  return genericReject({ scope: SCOPE, id: teamId }, feedback)
}

/** Test utility — drop every pending waiter without resolving. */
export function __resetForTesting(): void {
  genericReset()
}

/** Test utility — count of currently-pending waiters for `teamId`. */
export function pendingCount(teamId: string): number {
  return genericPendingCount({ scope: SCOPE, id: teamId })
}
