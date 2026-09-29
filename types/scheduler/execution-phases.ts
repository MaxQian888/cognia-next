/**
 * Where one execution's wall-clock time went.
 *
 * A scheduled run used to record only its total `duration`, which cannot tell
 * a slow model turn from a slow environment setup, a cold sidecar, or an alarm
 * that fired late. Each run now carries the slices it measured, in the order
 * they started. A phase a run never entered is absent rather than recorded as
 * zero, so "0 ms" always means "ran and was instant".
 *
 * The names are a closed set because the run sheet renders each through its
 * own translation key; an executor that wants a new slice adds it here first.
 */
export const TASK_EXECUTION_PHASE_NAMES = [
  /** From the slot the alarm was armed for to the moment execution began. */
  "fire-delay",
  /** Waiting for (or loading) the task type's executor. */
  "executor-load",
  /** Resolving or creating the conversation a chat-style run appends to. */
  "session",
  /** Settings, owning workspace, trust and the resolved send options. */
  "send-options",
  /** Opening the workspace turn the run executes in. */
  "workspace-lease",
  /** The project environment's setup script (or its reuse). */
  "environment-setup",
  /** From sending the prompt to the first event back from the agent host. */
  "first-response",
  /** From sending the prompt to the turn's final result. */
  "turn",
] as const

export type TaskExecutionPhaseName = (typeof TASK_EXECUTION_PHASE_NAMES)[number]

/**
 * How a phase was satisfied when it did not simply run:
 * - `reused`: an earlier identical result was still valid (setup fingerprint hit).
 * - `joined`: an identical operation was already in flight and this run waited on it.
 */
export type TaskExecutionPhaseOutcome = "reused" | "joined"

export interface TaskExecutionPhase {
  name: TaskExecutionPhaseName
  /** Milliseconds from the execution's `startedAt` to the phase's start. May be negative for `fire-delay`. */
  startOffsetMs: number
  durationMs: number
  outcome?: TaskExecutionPhaseOutcome
}

export function isTaskExecutionPhaseName(value: unknown): value is TaskExecutionPhaseName {
  return (
    typeof value === "string" && (TASK_EXECUTION_PHASE_NAMES as readonly string[]).includes(value)
  )
}
