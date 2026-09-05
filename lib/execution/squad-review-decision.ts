/**
 * Validate a Squad review decision against the interrupt it answers.
 *
 * The control gate (`run-control.ts`) calls this before any handler sees the
 * command, so a budget amount cannot be delivered to a deadlock gate and a
 * recovery choice cannot arrive without saying which host. Pure, so the CLI,
 * the companion RPC arm and the cockpit can all reject the same payloads for
 * the same reasons.
 */

import {
  squadReviewKindForInterrupt,
  type ExecutionRunInterrupt,
  type SquadReviewDecision,
  type SquadReviewKind,
  type TeamRecoveryChoice,
} from "@/types/execution/run"

export type SquadReviewDecisionProblem =
  /** The interrupt is a Squad review and an approve carried no decision. */
  | "decision_required"
  /** `decision.kind` does not match the interrupt's review kind. */
  | "kind_mismatch"
  /** A required field is missing or malformed. */
  | "malformed"
  /** The interrupt is not a Squad review, but a decision was supplied. */
  | "not_a_squad_review"

export interface SquadReviewDecisionValidation {
  ok: boolean
  problem?: SquadReviewDecisionProblem
  kind?: SquadReviewKind
}

const RECOVERY_CHOICES: readonly TeamRecoveryChoice[] = [
  "retry_same_host",
  "retry_host",
  "restart_run",
  "terminate",
]

const MAX_FEEDBACK_CHARS = 4_000

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  )
}

/** Shape check for one decision kind. */
export function isWellFormedSquadReviewDecision(value: unknown): value is SquadReviewDecision {
  if (!isPlainObject(value)) return false
  switch (value.kind) {
    case "plan":
      return (
        value.feedback === undefined ||
        (typeof value.feedback === "string" && value.feedback.length <= MAX_FEEDBACK_CHARS)
      )
    case "capability_audit":
      return true
    case "budget_extension":
      return (
        typeof value.extraTokens === "number" &&
        Number.isInteger(value.extraTokens) &&
        value.extraTokens > 0 &&
        value.extraTokens <= 10_000_000
      )
    case "deadlock":
      if (value.resetAll !== undefined && typeof value.resetAll !== "boolean") return false
      if (value.teammateIds !== undefined && !isIdList(value.teammateIds)) return false
      return (
        value.resetAll === true || (isIdList(value.teammateIds) && value.teammateIds.length > 0)
      )
    case "teammate_repair":
      return value.action === "rejoin" || value.action === "skip"
    case "replan":
      return value.edited === undefined || isPlainObject(value.edited)
    case "team_recovery": {
      if (!RECOVERY_CHOICES.includes(value.choice as TeamRecoveryChoice)) return false
      if (value.choice === "retry_host") {
        return typeof value.hostRef === "string" && value.hostRef.trim().length > 0
      }
      return value.hostRef === undefined || typeof value.hostRef === "string"
    }
    default:
      return false
  }
}

/**
 * Validate `decision` for `interrupt` and `action`.
 *
 * A `deny` needs no payload: refusing is the same shape for every kind. An
 * `approve` of a Squad review needs the matching payload, because "approve" on
 * its own does not say how much budget, which teammates, or which host.
 */
export function validateSquadReviewDecision(
  interrupt: Pick<ExecutionRunInterrupt, "type">,
  action: "approve" | "deny",
  decision: unknown
): SquadReviewDecisionValidation {
  const kind = squadReviewKindForInterrupt(interrupt.type)
  if (!kind) {
    return decision === undefined ? { ok: true } : { ok: false, problem: "not_a_squad_review" }
  }
  if (decision === undefined) {
    if (action === "deny") return { ok: true, kind }
    // Approving a plan or an audit needs no numbers. Everything else does.
    return kind === "plan" || kind === "capability_audit"
      ? { ok: true, kind }
      : { ok: false, problem: "decision_required", kind }
  }
  if (!isPlainObject(decision)) return { ok: false, problem: "malformed", kind }
  if (decision.kind !== kind) return { ok: false, problem: "kind_mismatch", kind }
  if (!isWellFormedSquadReviewDecision(decision)) return { ok: false, problem: "malformed", kind }
  return { ok: true, kind }
}
