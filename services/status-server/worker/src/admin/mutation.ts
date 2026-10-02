/**
 * The shape every operator write is planned in before it commits.
 *
 * A domain module (incidents, maintenance, delivery) reads current state,
 * validates the request and returns either an error or a write plan: the
 * D1 statements, the guard that is true only if the plan's first statement
 * actually changed its row, the response the operator will see, and the
 * audit entry. The admin router appends the guarded operation record and
 * audit row to the same batch, so a lost compare-and-swap commits nothing
 * but its own zero-row UPDATE.
 */

import type { StatusErrorCode } from "../../../../../lib/status/contract"
import type { AuditEntry } from "../platform/store"

export interface WriteGuard {
  sql: string
  params: unknown[]
}

export interface PlanError {
  kind: "error"
  code: StatusErrorCode
  currentRevision?: number
}

export interface WritePlan {
  kind: "write"
  /** The first statement is the compare-and-swap; it must change one row. */
  statements: D1PreparedStatement[]
  /** True only after the first statement committed (checks the write token). */
  guard: WriteGuard
  result: { status: number; body: unknown }
  audit: Omit<AuditEntry, "atMs" | "actor">
  /** Explains a zero-row compare-and-swap (usually a revision conflict). */
  onLostRace(): Promise<PlanError>
  /**
   * Statements appended to the same atomic batch after the audit row
   * (dirty-hour marks for edits that change past exclusions). They must be
   * harmless if the compare-and-swap lost: an extra rebuild mark is.
   */
  trailingStatements?: D1PreparedStatement[]
}

export type MutationPlan = PlanError | WritePlan

export function planError(code: StatusErrorCode, currentRevision?: number): PlanError {
  return currentRevision === undefined
    ? { kind: "error", code }
    : { kind: "error", code, currentRevision }
}

/** The actor and clock of one operator request. */
export interface OperatorContext {
  actor: string
  nowMs: number
}
