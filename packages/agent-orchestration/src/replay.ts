/**
 * Replay safety and attempt fencing (ADR-0217).
 *
 * Recovery may re-run a teammate only from a checkpoint that authorizes it,
 * and only one dispatch attempt may own a child at a time. These decisions are
 * pure so every host (and every store) reaches the same answer.
 */

import type {
  AgentTeamCheckpoint,
  AgentTeamChildRun,
  AgentTeamRunRecord,
  AgentTeamTrajectoryEvent,
} from "./records"

/** The waiting reason a child carries while the fair scheduler admits it. */
export const CHILD_ADMISSION_WAITING_REASON = "scheduler_admission"

/**
 * Whether a child may be replayed from `checkpoint`. The checkpoint must be
 * the child's, marked replay-safe, carry no side effect of unknown outcome or
 * unsafe intent, and no remote event may have been recorded after it: a
 * checkpoint cannot authorize replay of remote work recorded later.
 */
export function isChildReplaySafe(
  childRunId: string,
  checkpoint: AgentTeamCheckpoint | undefined,
  trajectory: readonly AgentTeamTrajectoryEvent[]
): boolean {
  if (
    !checkpoint ||
    checkpoint.childRunId !== childRunId ||
    checkpoint.replay !== "safe" ||
    checkpoint.sideEffects.some(
      (effect) =>
        effect.state === "unknown" || (effect.state === "intent" && effect.replay !== "safe")
    )
  ) {
    return false
  }
  return !trajectory.some(
    (event) =>
      event.childRunId === childRunId &&
      event.kind === "remote_event" &&
      event.sequence > checkpoint.trajectorySequence
  )
}

const PARKED_CHILD_STATUSES = new Set(["pausing", "paused", "sleeping", "needs_input"])
const FINISHED_CHILD_STATUSES = new Set(["completed", "cancelled", "terminated"])
const DISPATCHABLE_RUN_STATUSES = new Set(["running", "queued", "recovering"])

export type DispatchAttemptPlan =
  | { kind: "conflict"; reason: string }
  | {
      kind: "resume"
      child: AgentTeamChildRun
      attempt: number
      previousFailures: number
      /** Host a previous attempt asked the retry to run on (`retry_host:<ref>`). */
      retryTargetHostRef?: string
    }
  | { kind: "fresh"; attempt: 1 }

/**
 * Decide the next dispatch attempt for one teammate's task. A parked or
 * already-active child refuses; an unfinished child resumes under the next
 * attempt number (which fences out the previous attempt); otherwise a fresh
 * child starts at attempt 1. The run must be accepting dispatch.
 */
export function planDispatchAttempt(
  previous: AgentTeamChildRun | undefined,
  run: AgentTeamRunRecord | undefined
): DispatchAttemptPlan {
  if (previous && PARKED_CHILD_STATUSES.has(previous.status)) {
    return { kind: "conflict", reason: `Child is not accepting dispatch while ${previous.status}` }
  }
  if (
    previous &&
    (previous.status === "running" ||
      (previous.status === "queued" && previous.waitingReason === CHILD_ADMISSION_WAITING_REASON))
  ) {
    return { kind: "conflict", reason: "Child already has an active dispatch" }
  }
  if (!run || !DISPATCHABLE_RUN_STATUSES.has(run.status)) {
    return { kind: "conflict", reason: "Run is not accepting dispatch" }
  }
  const resumable = previous && !FINISHED_CHILD_STATUSES.has(previous.status) ? previous : undefined
  if (!resumable) return { kind: "fresh", attempt: 1 }
  const retryTargetHostRef = resumable.waitingReason?.startsWith("retry_host:")
    ? resumable.waitingReason.slice("retry_host:".length)
    : undefined
  return {
    kind: "resume",
    child: resumable,
    attempt: resumable.attempt + 1,
    previousFailures: resumable.resourceUsage.failures ?? 0,
    ...(retryTargetHostRef !== undefined ? { retryTargetHostRef } : {}),
  }
}

/** Whether the dispatch that holds `attempt` still owns the child. */
export function ownsDispatchAttempt(
  child: AgentTeamChildRun | undefined,
  attempt: number
): child is AgentTeamChildRun {
  return !!child && child.attempt === attempt
}
