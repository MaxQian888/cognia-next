/**
 * Workflow fan-out for a scheduled task that just settled.
 *
 * Shaped like `lib/goal/completion-linkage.ts`, and fired from the one place
 * that sees every outcome: the `finally` in `TaskScheduler.executeTask`, inside
 * the `!shouldRetry` branch, after the execution row is committed.
 *
 * The three obvious alternatives do not work, which is why this exists:
 *
 *  - `emitSchedulerEvent` fires only on success, and collapses the task type
 *    into a hard-coded subset. A failed task emits nothing at all, so the case
 *    an author most wants to react to is the one it cannot see.
 *  - `broadcastExecutionStatus` posts on a `BroadcastChannel`, which by spec
 *    does not deliver to its own posting context, so an in-process subscriber
 *    never hears it.
 *  - `notifyTaskEvent` is opt-in per task.
 *
 * Self-trigger is refused structurally rather than left to a cooldown: a
 * `workflow`-type task names the workflow it runs in its own payload, so a
 * workflow listening for its own scheduled run is decidable from data already
 * in hand and is rejected outright, the way `workflow-completion-fanout` does.
 */

import { loggers } from "@cognia/logging"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import {
  createFanOutState,
  fanOutTrigger,
  type TriggerFanOutState,
} from "@/lib/workflow/runtime/trigger-fan-out"

const log = loggers.scheduler

/**
 * Module-level rather than per-init, because the scheduler owns its own
 * lifecycle and there is no provider to mount this under. The scheduler's tab
 * lock already guarantees one timing owner, so two tabs cannot double-fire.
 */
let state: TriggerFanOutState | null = null

function fanOutState(): TriggerFanOutState {
  state ??= createFanOutState()
  return state
}

/** The workflow a `workflow`-type task runs, when it names one. */
function workflowIdOfTask(task: ScheduledTask): string | undefined {
  const payload = task.payload as { workflowId?: unknown } | undefined
  return typeof payload?.workflowId === "string" ? payload.workflowId : undefined
}

export async function dispatchScheduledTaskSettled(
  task: ScheduledTask,
  execution: TaskExecution
): Promise<void> {
  try {
    const selfWorkflowId = task.type === "workflow" ? workflowIdOfTask(task) : undefined
    await fanOutTrigger({
      state: fanOutState(),
      kind: "trigger.scheduler.taskCompleted",
      match: {
        taskId: task.id,
        taskType: task.type,
        status: execution.status,
        terminalReason:
          typeof execution.terminalReason === "string" ? execution.terminalReason : undefined,
        projectId: task.projectId,
      },
      payload: {
        taskId: task.id,
        taskName: task.name,
        taskType: task.type,
        executionId: execution.id,
        status: execution.status,
        terminalReason: execution.terminalReason ?? null,
        error: execution.error ?? null,
        durationMs: execution.duration ?? null,
        retryAttempt: execution.retryAttempt,
        triggerSource: execution.triggerSource ?? null,
        projectId: task.projectId ?? null,
        startedAt: execution.startedAt?.getTime?.() ?? null,
        completedAt: execution.completedAt?.getTime?.() ?? null,
      },
      // A workflow-type task that runs workflow W, fanning out to W, is an
      // unconditional loop. Rejected outright rather than narrowed.
      reject: (workflowId) =>
        selfWorkflowId === workflowId ? "this task runs that workflow" : null,
    })
  } catch (error) {
    log.warn("task-completion-linkage: fan-out failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Test-only: drop the shared cooldown and in-flight state. */
export function __resetTaskCompletionLinkageForTesting(): void {
  state = null
}
