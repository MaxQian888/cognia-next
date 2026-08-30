/**
 * Row shapes for the online-evaluation tables (Dexie v211).
 *
 * Split from the accessors because `lib/db/schema.ts` needs these types to
 * declare the tables and must not pull in the CRUD module — the same split the
 * collab mirrors use.
 */

import type {
  EvalObservationV1,
  JudgeSamplingDecision,
  OnlineEvalPolicyV1,
} from "@cognia/eval-core"

/** A stored observation. The envelope IS the row; nothing is reshaped. */
export type EvalObservationRow = EvalObservationV1

/** A stored policy, plus the workspace scoping Dexie indexes on. */
export interface EvalOnlinePolicyRow extends OnlineEvalPolicyV1 {
  /** Denormalized from `selector` so `[workspaceId+enabled]` can be an index. */
  workspaceId: string
  /** Dexie cannot index a boolean; 1/0 mirrors `enabled`. */
  enabledFlag: 0 | 1
}

export type EvalOnlineQueueState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  /** Deliberately terminal: the budget said no, and that is a RESULT, not a retry. */
  | "skipped"

export interface EvalOnlineQueueRow {
  id: string
  policyId: string
  policyVersionId: string
  traceId: string
  /**
   * `${policyVersionId}::${traceId}` — the idempotency key. A trace re-offered
   * by a retry or a second transport must not be scored, or charged, twice.
   */
  dedupeKey: string
  state: EvalOnlineQueueState
  /** Set when `state` is `skipped`, so a quiet policy says which control silenced it. */
  skipReason?: JudgeSamplingDecision
  /** USD reserved before dispatch and released on settle. */
  reservedUsd: number
  attempts: number
  error?: string
  enqueuedAt: number
  updatedAt: number
}

/**
 * Per-policy, per-day spend. A separate row rather than a counter on the policy
 * so the ledger is auditable and a policy edit cannot erase the day's spend.
 */
export interface EvalOnlineBudgetRow {
  /** `${policyId}::${day}`. */
  id: string
  policyId: string
  /** UTC `YYYY-MM-DD`. */
  day: string
  spentUsd: number
  /** Currently-held reservations, released as tasks settle. */
  reservedUsd: number
  judgedCount: number
  updatedAt: number
}

/** UTC day key. Local time would make a cap mean different things per device. */
export function budgetDayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function budgetRowId(policyId: string, day: string): string {
  return `${policyId}::${day}`
}

export function queueDedupeKey(policyVersionId: string, traceId: string): string {
  return `${policyVersionId}::${traceId}`
}
