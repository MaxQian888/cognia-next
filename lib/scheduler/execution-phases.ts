/**
 * Recording where a scheduled execution's time went.
 *
 * The scheduler and the executors both write into the same `TaskExecution`
 * object while it runs, and the scheduler persists that object when the run
 * settles, so a phase is recorded by appending to `execution.phases`. Offsets
 * are relative to `execution.startedAt`, which keeps a row self-describing
 * without a second clock.
 *
 * A phase is recorded whether its work succeeded or threw: a setup script that
 * failed after four minutes is exactly the slice someone opening a failed run
 * needs to see.
 */

import type {
  TaskExecution,
  TaskExecutionPhase,
  TaskExecutionPhaseName,
  TaskExecutionPhaseOutcome,
} from "@/types/scheduler"

type PhaseTarget = Pick<TaskExecution, "startedAt" | "phases">

export interface MeasurePhaseOptions<T> {
  /** Clock override for tests. */
  now?: () => number
  /** Classify a successful result (e.g. a setup that was reused rather than run). */
  outcome?: (result: T) => TaskExecutionPhaseOutcome | undefined
}

/** Append one measured slice. Negative durations (clock skew) clamp to zero. */
export function recordPhase(
  execution: PhaseTarget,
  name: TaskExecutionPhaseName,
  startedAtMs: number,
  endedAtMs: number,
  outcome?: TaskExecutionPhaseOutcome
): TaskExecutionPhase {
  const phase: TaskExecutionPhase = {
    name,
    startOffsetMs: Math.round(startedAtMs - execution.startedAt.getTime()),
    durationMs: Math.max(0, Math.round(endedAtMs - startedAtMs)),
    ...(outcome ? { outcome } : {}),
  }
  execution.phases = [...(execution.phases ?? []), phase]
  return phase
}

/** Run `work` and record how long it took under `name`, even when it throws. */
export async function measurePhase<T>(
  execution: PhaseTarget,
  name: TaskExecutionPhaseName,
  work: () => Promise<T>,
  options: MeasurePhaseOptions<T> = {}
): Promise<T> {
  const now = options.now ?? Date.now
  const startedAtMs = now()
  let result: T
  try {
    result = await work()
  } catch (error) {
    recordPhase(execution, name, startedAtMs, now())
    throw error
  }
  recordPhase(execution, name, startedAtMs, now(), options.outcome?.(result))
  return result
}

/**
 * One-line summary for the run's log, e.g.
 * `fire-delay 12ms · session 40ms · environment-setup 3ms (reused) · turn 8.2s`.
 */
export function summarizePhases(phases: readonly TaskExecutionPhase[] | undefined): string {
  if (!phases || phases.length === 0) return ""
  return phases
    .map((phase) => {
      const outcome = phase.outcome ? ` (${phase.outcome})` : ""
      return `${phase.name} ${formatPhaseDuration(phase.durationMs)}${outcome}`
    })
    .join(" · ")
}

export function formatPhaseDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(durationMs / 1000)
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
}
