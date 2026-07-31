/**
 * Resolution of the blocking lead-review policy (ADR-0071).
 *
 * Two surfaces have to agree on the answers here — the synthesizer (does this
 * run get review nodes at all?) and the review executor (how many revisions do
 * I get?) — and they read the config at different times, in different files. A
 * disagreement is silent and severe: nodes emitted with no budget, or a budget
 * applied to nodes that were never emitted. So both read this.
 */

import type { AgentTeamConfig } from "@/types/agent/agent-team"

/**
 * Worker revision attempts after a `changes_requested`, when the config leaves
 * it unset. Two is what the goal specifies: enough for the common
 * "misread the ask" and "missed an edge case" rounds, few enough that a worker
 * that cannot satisfy the lead fails fast instead of burning the run.
 */
export const DEFAULT_TASK_REVIEW_MAX_REVISIONS = 2

/**
 * Ceiling on the revision budget. Each revision is a worker turn plus another
 * lead review, so an unbounded budget is a way to burn a run's tokens on a
 * worker that is never going to satisfy the lead.
 */
export const MAX_TASK_REVIEW_REVISIONS = 5

/** Review is opt-in: an unconfigured team behaves exactly as it did before. */
export function isTaskReviewEnabled(config: AgentTeamConfig | undefined): boolean {
  return config?.taskReview?.enabled === true
}

/**
 * Coerce an operator-entered budget into the allowed range. Exported so the
 * settings UI clamps with the same bounds the runtime resolves against —
 * a UI-only ceiling would be a ceiling the runtime doesn't have.
 */
export function clampMaxRevisions(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TASK_REVIEW_MAX_REVISIONS
  return Math.max(0, Math.min(MAX_TASK_REVIEW_REVISIONS, Math.floor(value)))
}

/**
 * Revision budget for one task. Clamped so a nonsense config cannot make the
 * loop run backwards or forever; 0 is meaningful (review once, never revise).
 */
export function resolveMaxRevisions(config: AgentTeamConfig | undefined): number {
  const raw = config?.taskReview?.maxRevisions
  if (typeof raw !== "number") return DEFAULT_TASK_REVIEW_MAX_REVISIONS
  return clampMaxRevisions(raw)
}

/** Node id of the review node guarding `taskId`'s dispatch node. */
export function reviewNodeId(taskId: string): string {
  return `review:${taskId}`
}
